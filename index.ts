import couchbase from "couchbase";
import type { Zotero } from "@retorquere/zotero-sync/typings/zotero"

interface StoreOptions {
  bucketName?: string
}

export class Store implements Zotero.Store {

  /**
   * @implements Zotero.Store.libraries
   */
  public libraries: string[];

  private url: string;
  private username: string;
  private password: string;
  private bucketName: string;
  private cluster: Cluster|null;

  constructor(url: string, username: string, password: string, options: StoreOptions = {}) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.bucketName = options.bucketName || "zotero";
    this.cluster = null;
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
  public async getZoteroBucket(): Promise<Bucket> {
    return (await this.getCluster()).bucket(this.bucketName);
  }

  public async init(): Promise<Store> {


    return this;
  }

  /**
   * Returns a map of keys (keys) and versions (values) of the records with the given
   * zotero keys
   * @param {String[]} keys
   * @returns {Promise<{}>}
   */
  async getRecordVersions(keys) {
    let keyList = keys.map(key => `'${key}'`).join(",");
    let query = `select \`key\`, version from ${this.adapter.bucketName}.${this.libraryId}.${this.name} where \`key\` in [${keyList}]`
    let result = (await (await this.adapter.getCluster()).query(query)).rows;
    let map = {};
    for (let {key, version} of result) {
      map[key] = version;
    }
    return map;
  }


  /**
   * @implements Zotero.Store.remove
   * @param user_or_group_prefix
   */
  public async remove(user_or_group_prefix: string): Promise<void> {
    try {
      await fs.promises.unlink(path.join(this.url, encodeURIComponent(user_or_group_prefix) + '.json'))
      this.libraries = this.libraries.filter(prefix => prefix !== user_or_group_prefix)
    } catch (err) {
      // pass
    }
  }

  /**
   * @implements Zotero.Store.get
   * @param user_or_group_prefix
   */
  public async get(user_or_group_prefix): Promise<Library> {
    const library = new Library
    if (!this.libraries.includes(user_or_group_prefix)) this.libraries.push(user_or_group_prefix)
    return await library.load(path.join(this.url, encodeURIComponent(user_or_group_prefix) + '.json'))
  }
}

export class Library implements Zotero.Library {

  public name: string
  public version: number

  private readonly libraryId: string;
  private store: Store;
  private cbCollection?: Collection;

  constructor(store: Store, libraryId: string) {
    this.store = store;
    this.libraryId = libraryId;
  }

  public async init(): Promise<Library> {
    const libraryId = this.libraryId;
    const storeName = this.name;
    const zoteroBucket = await this.store.getZoteroBucket();
    let wait = false;
    // create scope
    try {
      await zoteroBucket.collections().createScope(libraryId);
      //console.log(`Created scope ${this.bucketName}.${libraryId}`);
      wait = true;
    } catch (e) {
      if (!e.toString().includes("exists")) {
        throw e;
      }
    }
    // create collection
    let collSpec = {
      name: storeName,
      scopeName: libraryId,
      maxExpiry: 0
    };
    try {
      await zoteroBucket.collections().createCollection(collSpec);
      //console.log(`Created collection ${this.bucketName}.${libraryId}.${storeName}`);
      wait = true;
    } catch (e) {
      if (!e.toString().includes("exists")) {
        throw e;
      }
    }
    // small timeout for couchbase to create the needed objects
    if (wait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await this.createPrimaryIndex(libraryId, storeName);
    this.cbCollection = (await this.store.getZoteroBucket()).scope(libraryId).collection(storeName);
    return this;
  }

  private async createPrimaryIndex( scopeName: string, collectionName: string) : Promise<void> {
    let query = `create primary index on default:${this.bucketName}.${scopeName}.${collectionName}`
    try {
      await (await this.store.getCluster()).query(query);
      //console.log(`Created primary index on default:${this.bucketName}.${scopeName}.${collectionName}`);
    } catch (e) {
      if (e.context && e.context.first_error_message && e.context.first_error_message.includes("already exists")) {
        return;
      }
      throw e;
    }
    const attempts = 3;
    let timeout = 3;
    let tries = 0;
    const cluster = await this.getCluster();
    while (tries <= attempts) {
      tries++;
      let query = `SELECT RAW state FROM system:indexes WHERE name = "#primary"        
                    AND bucket_id = "${this.bucketName}"
                    AND scope_id ="${scopeName}"
                    AND keyspace_id ="${collectionName}"`
      let result = (await cluster.query(query)).rows;
      if (result.length && result[0].toString() === "online") {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, timeout*1000));
    }
    if (tries === attempts) {
      throw new Error(`Aborted waiting for primary index on ${this.bucketName}.${scopeName}.${collectionName} after ${timeout * tries} seconds`);
    }
  }


  public async add_collection(collection: Zotero.Collection) {
    await this.remove_collections([collection.key])
    this.collections.push(collection)
  }
  public async remove_collections(keys: string[]): Promise<void> {
    this.collections = this.collections.filter(coll => !keys.includes(coll.key))
  }

  public async add(item: Zotero.Item.Any): Promise<void> {
    await this.remove([item.key])
    this.items.push(item)
  }
  public async remove(keys: string[]): Promise<void> {
    this.items = this.items.filter(item => !(keys.includes(item.key)))
  }

  public async save(name: string, version: number): Promise<void> {
    this.name = name
    this.version = version
    await fs.promises.writeFile(this., stringify({ items: this.items, collections: this.collections, name: this.name, version: this.version }))
  }
}




