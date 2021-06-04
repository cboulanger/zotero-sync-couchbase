import { Sync } from '@retorquere/zotero-sync/index'
import type { Zotero } from '@retorquere/zotero-sync/typings/zotero'
import { Store, StoreOptions } from './src'
import process from 'process';
import dotenv from 'dotenv';
import { connect  } from 'couchbase';
const Gauge = require('gauge');

(async () => {
    // config
    dotenv.config();
    const {
        ZOTERO_API_KEY,
        COUCHBASE_URL,
        COUCHBASE_USER,
        COUCHBASE_PASSWORD,
        COUCHBASE_BUCKET
    } = process.env as {[key : string]: string};
    const storeOptions : StoreOptions = {
        bucketName : COUCHBASE_BUCKET as string
    }

    // create couchbase bucket for our test
    const cluster = await connect(COUCHBASE_URL, {
        username: COUCHBASE_USER,
        password: COUCHBASE_PASSWORD
    });
    const bucketSettings = {
        name: storeOptions.bucketName,
        ramQuotaMB: 200,
        bucketType: BucketType.Couchbase,
    }
    try {
        // @ts-ignore
        await cluster.buckets().createBucket(bucketSettings); // parameter typing is incorrect in couchbase source
        await cluster.queryIndexes().createPrimaryIndex(storeOptions.bucketName as string);
    } catch (e) {
        if (!e.message.includes('bucket exists') ) {
            throw e;
        }
    }

    // initialize the sync engine
    const syncEngine = new Sync;
    await syncEngine.login(ZOTERO_API_KEY);

    // configure visual feedback
    const gauge = new Gauge;
    syncEngine.on(Sync.event.library, (library: {type:string, name: string }, index: number, total: number) => {
        let name = library.type === "group" ? library.name : "User library";
        gauge.show(`Synchronizing library "${name}" (${index}/${total})`, index/total);
    });
    syncEngine.on(Sync.event.remove, (type: string, objects: string[]) => {
        gauge.show(`Removing ${objects.length} ${type}`);
    });
    syncEngine.on(Sync.event.collection, (collection: Zotero.Collection, index: number, total: number) => {
        gauge.show(`Saving collection ${index}/${total}`, index/total);
    });
    syncEngine.on(Sync.event.item, (item: Zotero.Item.Any, index, total) => {
        gauge.show(`Saving item ${index}/${total}`, index/total);
    });

    // error handling
    syncEngine.on(Sync.event.error, e => {
        gauge.hide();
        console.error(`Error during task "${gauge._status.section.replace(/"/g,"'")}": ${e.message}`);
    });

    // synchronize with the couchbase store
    const store = new Store(COUCHBASE_URL, COUCHBASE_USER, COUCHBASE_PASSWORD, storeOptions);
    await syncEngine.sync(store);
    gauge.hide();
    process.exit(0);
})().catch(err => {
    console.log(err)
    process.exit(1)
})
