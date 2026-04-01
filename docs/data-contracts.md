# Data Contracts (MVP)

## Coordinate contract

```json
{
  "ra_deg": 150.114,
  "dec_deg": -2.345,
  "source": "radec_text|python_csv|python_fits_header|mcp_s3_reader"
}
```

## Catalog row contract

```json
{
  "catalog": "euclid|desi",
  "object_id": "DESI_00001",
  "ra_deg": 150.1138,
  "dec_deg": -2.3449,
  "mag": 19.12,
  "class_label": "star"
}
```

## Crossmatch row contract

```json
{
  "euclid_object_id": "EUCLID_00001",
  "desi_object_id": "DESI_00005",
  "ra_deg": 150.114,
  "dec_deg": -2.345,
  "euclid_mag": 20.1,
  "desi_mag": 19.8,
  "separation_arcsec": 0.49,
  "class_label": "star"
}
```
