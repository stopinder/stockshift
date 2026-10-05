# Synthetic CSV golden corpus

These invented industrial fittings represent **100 reconciliation outcomes**, not
100 records per input. The old file has 89 records and the incoming file has 91.

- 50 unchanged exact SKUs
- 15 price increases
- 10 price decreases
- 10 incoming-only products (`new`)
- 8 old-only products (`absent` means absent from this file, not discontinued)
- 5 exact SKUs with description-only changes
- 2 separate missing-SKU review records, one on each side, never paired

Description-only changes have the primary outcome `changed`; the 25 price changes
and 5 descriptions produce a 30-row changed-products export. Review and absent/new
rows do not enter that export. Other edge cases live in parametrized Python tests.

Configuration is explicit: UTF-8, comma delimiter, decimal point, no grouping,
`SKU → supplier_sku`, `Price → cost_price`, `Description → description`; GBP,
pack quantity `1`, unit `each`, unit pricing, net tax basis. These are fixture
assumptions, not application/customer defaults.
