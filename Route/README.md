# Route API Tests

Below are the available test cases for the Route API. Each item includes a brief summary and a link to the corresponding HTTP request file.

- **Get route catalog:** [getCatalog.http](./getCatalog.http)
- **Create route with existing locations:** [newRouteWithExistingLocations.http](./newRouteWithExistingLocations.http)
- **Create route with new locations:** [newRouteWithNewLocations.http](./newRouteWithNewLocations.http)
- **Assign route to unit:** [newRouteAssignment.http](./newRouteAssignment.http)
- **Create new route assignment with new route:** [newRouteAssignmentWithNewRoute.http](./newRouteAssignmentWithNewRoute.http)

---

## Get Catalog By Source - Target - Customer

This case retrieves the route catalog based on the private codes of the source customer and the target customer, as well as the reference. It is useful for scenarios where you need to filter routes by specific customer relationships.

```http
POST {{baseUrl}}/Route/GetCatalog
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "sourceCustomerPrivateCode": "GTC",
  "targetCustomerPrivateCode": "627511",
  "targetPrivateCode": "627511-1"
}
```


### Example 1: Completed Job (Drop Empty)

**Data**

- **Pickup Location (Source)**: `VILLA NUEVA, GUAT.` → `LocationCode = GTC`
- **Drop Location (Target)**: `Modas Industria, S.A.` → `CustomerPrivateCode = 128649` and `SubLocation = 128649-1`

**API Call**

```
POST {{baseUrl}}/Route/GetCatalog
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "sourceCustomerPrivateCode": "GTC",
  "targetCustomerPrivateCode": "128649",
  "targetPrivateCode": "128649-1"
}

```

---

### Example 2: Completed Job (Pickup Full)

**Data**

- **Pickup Location (Source)**: `K&Ortega’s Import S.A.` → `CustomerPrivateCode = 110824` and `SubLocation = 110824-1`
- **Drop Location (Target)**: `Maria Luisa` → `LocationCode = ML`

**API Call**

```
POST {{baseUrl}}/Route/GetCatalog
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "sourceCustomerPrivateCode": "110824",
  "sourcePrivateCode": "110824-1",
  "targetCustomerPrivateCode": "ML"
}

```

---

### Example 3: Completed Job (Drop Full)

**Data**

- **Pickup Location (Source)**: `VILLA NUEVA, GUAT.` → `LocationCode = GTC`
- **Drop Location (Target)**: `Empaques San Lucas` → `CustomerPrivateCode = 627511` and `SubLocation = 627511-1`

**API Call**

```
POST {{baseUrl}}/Route/GetCatalog
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "sourceCustomerPrivateCode": "GTC",
  "targetCustomerPrivateCode": "627511",
  "targetPrivateCode": "627511-1"
}

```

---

With this mapping, anyone can look at a job (pickup + drop-off) and construct the corresponding API call to retrieve the route catalog.