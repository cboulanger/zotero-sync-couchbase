# Couchbase  Store for @retorquere/zotero-sync

This is a store implementation for https://github.com/retorquere/zotero-sync
which can do a one-way sync from Zotero to any backend that has an API.

This implementation allows to backup Zotero libraries in a
https://www.couchbase.com database. Zotero data is stored as JSON data in
Couchbase collections that are named after the synchronized object types
("items", "collections" only), which are themselves stored in Couchbase scopes
that are named "g\<group id>" or "u\<user id>".

## Usage

```bash
npm install @cboulanger/zotero-sync-couchbase
```

See [the test script](test.ts) for an example.
