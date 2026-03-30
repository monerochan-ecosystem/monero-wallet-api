## ScanSettings.json

list of the wallets, their start_height to start scanning from
node_urls

## \_cache.json

contains raw results of the scan, no aggregated data

## \_stats.json

contains aggregated data derived from the scan cache,
like amount found per subaddress

separation of stats and cache, means we can perform operations without an active scan,
like creation of subaddresses, signing of transactions

## .env

secret view and spend keys for the wallets
