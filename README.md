# Couchbase  Store for @retorquere/zotero-sync

This is a store implementation for https://github.com/retorquere/zotero-sync.

This implementation allows to backup Zotero libraries in a
https://www.couchbase.com database. Zotero data is stored as JSON data in
Couchbase 'collections' that are named after the synchronized object types
("items", "collections" only), which are themselves stored in Couchbase 'scopes'
that are named "g\<group id>" or "u\<user id>".

## Testing

```bash
git clone https://github.com/cboulanger/zotero-sync-couchbase.git
cd zotero-sync-couchbase
cp .env.dist ./.env
# edit .env and provide the values needed there
npm test
```

See [the test script](test.ts) for an example on how to integrate the library in your project.
