import couchbase from "couchbase";
import type { Zotero } from "@retorquere/zotero-sync/typings/zotero"

/**
 * Helper function to create a couchbase collection. Resolves with the collection object once it has
 * been created
 * @param {Bucket} bucket
 * @param {String} scopeName
 * @param {String} collectionName
 * @param {Number} timeout
 * @return {Promise<Collection>}
 */
async function createCbCollection(bucket: Bucket, scopeName: string, collectionName: string, timeout: number) : Promise<Collection>{
  // create scope
  try {
    await bucket.collections().createScope(scopeName);
    //console.log(`Created scope ${bucketName}.${scopeName}`);
  } catch (e) {
    if (!e.toString().includes("exists")) {
      throw e;
    }
  }
  // create collection
  let collSpec = {
    name: collectionName,
    scopeName: scopeName,
    maxExpiry: 0
  };
  try {
    await bucket.collections().createCollection(collSpec);
    //console.log(`Created collection ${bucketName}.${scopeName}.${storeName}`);
  } catch (e) {
    if (!e.toString().includes("exists")) {
      throw e;
    }
  }
  const now = new Date().getTime();
  let isTimedOut = false;
  let collection: Collection | undefined;
  while (!collection && !isTimedOut) {
    try {
      collection = await bucket.scope(scopeName).collection(collectionName)
    } catch (e) {
      console.log(e.message);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    isTimedOut = new Date().getTime() > now + timeout;
  }
  if (isTimedOut) {
    throw new Error(`Timeout of ${timeout} ms reached when creating collection ${bucket.name}.${scopeName}.${collectionName}`);
  }
  // how can I tell Typescript that at this point, collection will always be of type Collection?
  // @ts-ignore
  return collection;
}

/**
 * Helper function to create a primary index on a collection. Returns a promise that resolves
 * when the index is online.
 * @param {Cluster} cluster
 * @param {String} bucketName
 * @param {String} scopeName
 * @param {String} collectionName
 * @param {Number} timeout
 */
async function createPrimaryIndex(cluster: Cluster, bucketName: string, scopeName: string, collectionName: string, timeout: number) : Promise<void> {
  let query = `create primary index on default:\`${bucketName}\`.\`${scopeName}\`.\`${collectionName}\``;
  try {
    await cluster.query(query);
    //console.log(`Created primary index on default:${this.bucketName}.${scopeName}.${collectionName}`);
  } catch (e) {
    let err = e.context ? e.context : e;
    if (err.first_error_message && err.first_error_message.includes("already exists")) {
      return;
    }
    throw e;
  }
  const now = new Date().getTime();
  let isTimedOut = false;
  while (!isTimedOut) {
    let query = `SELECT RAW state FROM system:indexes WHERE name = "#primary"        
                    AND bucket_id = "${bucketName}"
                    AND scope_id ="${scopeName}"
                    AND keyspace_id ="${collectionName}"`
    let result = (await cluster.query(query)).rows;
    if (result.length && result[0].toString() === "online") {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    isTimedOut = new Date().getTime() > now + timeout;
  }
  if (isTimedOut) {
    throw new Error(`Timeout of ${timeout} ms reached when creating primary index on ${bucketName}.${scopeName}.${collectionName}`);
  }
}

/**
 * Options that can be passed as the last arguments to the Store constructor
 */
export interface StoreOptions {
  /**
   * The name of the bucket that contains the zotero data. Defaults to "zotero"
   */
  bucketName?: string,
  /**
   * An optional function that translates a user-or-group prefix to a valid
   * couchbase scope name. Defaults to {@link Store#createScopeNameFromPrefixImpl}
   * @param user_or_group_prefix
   */
  createScopeNameFromPrefixFunc?: (user_or_group_prefix: string) => string

  /**
   * Timeout in microseconds that is waited for the couchbase server to create
   * the needed objects asynchronously ; defaults to 5000 ms
   */
  timeout?: number

  /**
   * If true (default), throw sync errors, if false just log them
   */
  throwSyncErrors?: boolean,

  /**
   * Name that is stored for the User Library
   */
  userLibraryName?: string
}

export class Store implements Zotero.Store {

  public libraries : string[];
  public readonly timeout: number;
  public readonly options: StoreOptions;
  public readonly bucketName: string;

  // internal config
  private readonly url: string;
  private readonly username: string;
  private readonly password: string;
  private cluster?: Cluster;

  constructor(url: string, username: string, password: string, options: StoreOptions = {}) {
    this.url = url;
    this.username = username;
    this.password = password;
    if (!("throwSyncErrors" in options)) {
      options.throwSyncErrors = true;
    }
    if (!options.userLibraryName) {
      options.userLibraryName = "User library"
    }
    this.options = options;
    this.bucketName = options.bucketName || "zotero";
    this.timeout = options.timeout || 5000;
    this.libraries = [];
  }

  /**
   * Returns the couchbase Cluster instance
   * @return Promise<Cluster>
   */
  public async getCluster() : Promise<Cluster> {
    if (!this.cluster) {
      this.cluster = await couchbase.connect(this.url, {
        username: this.username,
        password: this.password,
      });
    }
    return this.cluster;
  }

  /**
   * Returns the couchbase bucket in which the zotero data is stored
   * @returns {Promise<Bucket>}
   */
  public async getBucket(): Promise<Bucket> {
    return (await this.getCluster()).bucket(this.bucketName);
  }

  /**
   * Given a zotero REST API user-or-group prefix (e.g. users/12345 or groups/12345), return
   * a library id that can be stored as a scope name in couchbase.
   * @param {String} user_or_group_prefix
   * @protected
   */
  public createScopeNameFromPrefix(user_or_group_prefix:string) {
    const impl = this.options.createScopeNameFromPrefixFunc || this.createScopeNameFromPrefixImpl;
    return impl(user_or_group_prefix);
  }

  /**
   * The default implementation shortens the prefix to "u12345" or "g12345",
   * respectively.
   * @param {String} user_or_group_prefix
   * @protected
   */
  protected createScopeNameFromPrefixImpl(user_or_group_prefix:string) {
    return user_or_group_prefix
        .replace(/roups\/|sers\//, "")
        .replace("/","");
  }

  /**
   * Removes a library from the store
   * @implements Zotero.Store.remove
   * @param user_or_group_prefix
   */
  public async remove(user_or_group_prefix: string): Promise<void> {
    const scopeName = this.createScopeNameFromPrefix(user_or_group_prefix);
    const bucket = await this.getBucket();
    try {
      await bucket.collections().dropScope(scopeName);
    } catch(e : Error | any) {
      if (this.options.throwSyncErrors) {
        throw e;
      }
      console.error(e.message);
    }
    this.libraries = this.libraries.filter(prefix => prefix !== user_or_group_prefix);
  }

  /**
   * Gets a library, creating it if it doesn't exist.
   * @implements Zotero.Store.get
   * @param user_or_group_prefix
   * @return {Promise<Library>}
   */
  public async get(user_or_group_prefix:string): Promise<Library> {
    const library = new Library(this, user_or_group_prefix);
    if (!this.libraries.includes(user_or_group_prefix)) {
      this.libraries.push(user_or_group_prefix);
    }
    return await library.init();
  }
}

/**
 * Implementation of a Zotero library object
 */
export class Library implements Zotero.Library {

  // interface properties
  public name: string = "";
  public version: number = 0;

  protected synchronizedObjectTypes = ["items", "collections"];

  // internal config
  private readonly user_or_group_prefix: string;
  private readonly store: Store;
  private cbCollections: Map<string, Collection>;

  constructor(store: Store, user_or_group_prefix: string) {
    this.store = store;
    this.user_or_group_prefix = user_or_group_prefix;
    this.cbCollections = new Map;
  }

  /**
   * Returns "user" or "group"
   */
  public getType(): string {
    return this.user_or_group_prefix.startsWith("/users") ? "user" : "group";
  }

  /**
   * Initialize the library instance. This creates the necessary couchbase
   * collections. Resolves with the library instance when done.
   */
  public async init(): Promise<Library> {
    const cluster = await this.store.getCluster();
    const bucket = await this.store.getBucket();
    const scopeName = this.store.createScopeNameFromPrefix(this.user_or_group_prefix);
    // create collections for synchronized zotero types plus one for sync metadata
    const collectionNames = this.synchronizedObjectTypes.concat("meta");
    for (const collectionName of collectionNames) {
      const cbColl = await createCbCollection(bucket, scopeName, collectionName, this.store.timeout);
      await createPrimaryIndex(cluster, bucket.name, scopeName, collectionName, this.store.timeout);
      this.cbCollections.set(collectionName, cbColl);
    }
    const metaCollection = this.cbCollections.get("meta") as Collection;
    try {
      this.name = (await metaCollection.get("name")).content;
      this.version = (await metaCollection.get("version")).content;
    } catch (e) {
      if (!e.message.includes("document not found")){
        if (this.store.options.throwSyncErrors) {
          throw e;
        }
        console.error(e.message);
      }
    }
    return this;
  }

  /**
   * Adds a Zotero collection object
   * @param {Zotero.Collection} collection
   */
  public async add_collection(collection: Zotero.Collection): Promise<void> {
    const cbCollection = this.cbCollections.get("collections") as Collection;
    try {
      await cbCollection.upsert(collection.key, collection);
    } catch (e) {
      if (this.store.options.throwSyncErrors) {
        throw e;
      }
      console.error(e.message);
    }
  }


  /**
   * Removes a Zotero collection object
   * @param {string[]} keys
   */
  public async remove_collections(keys: string[]): Promise<void> {
    const cbCollection = this.cbCollections.get("collections") as Collection;
    for (const key of keys) {
      try {
        await cbCollection.remove(key);
      } catch (e) {
        if (!e.message.includes("document not found")) {
          if (this.store.options.throwSyncErrors) {
            throw e;
          }
          console.error(e.message);
        }
      }
    }
  }

  /**
   * Adds a Zotero item object
   * @param {Zotero.Item.Any} item
   */
  public async add(item: Zotero.Item.Any): Promise<void> {
    const cbCollection = this.cbCollections.get("items") as Collection;
    try {
      await cbCollection.upsert(item.key, item);
    } catch (e) {
      if (this.store.options.throwSyncErrors) {
        throw e;
      }
      console.error(e.message);
    }
  }

  /**
   * Removes an Zotero item object
   * @param {string[]} keys
   */
  public async remove(keys: string[]): Promise<void> {
    const cbCollection = this.cbCollections.get("items") as Collection;
    for (const key of keys) {
      try {
        await cbCollection.remove(key);
      } catch (e) {
        if (!e.message.includes("document not found")) {
          if (this.store.options.throwSyncErrors) {
            throw e;
          }
          console.error(e.message);
        }
      }
    }
  }

  /**
   * Saves the Library
   * @param {String|undefined} name Descriptive Name of the library.
   * Is empty in the case of the user library. If {@link StoreOptions.userLibraryName}
   * is set, this name will be used, otherwise "User library".
   * @param {Number} version
   */
  public async save(name: string, version: number): Promise<void> {
    if (!name) {
      name = this.store.options.userLibraryName as string;
    }
    const metaCollection = this.cbCollections.get("meta") as Collection;
    await metaCollection.upsert("version", version);
    await metaCollection.upsert("name", name);
  }
}
