# eBay AutoShop Web

This is the minimalist web rewrite of the Electron eBay AutoShop.

## What stayed

- AliExpress OAuth authorization
- AliExpress token persistence and automatic refresh
- AliExpress Dropshipping product lookup
- SKU/variant selector
- Supplier price, inventory, delivery, product images
- Suggested selling-price calculation
- eBay image matching
- eBay title/category/price matching
- OpenAI vision fallback
- OpenAI eBay-description generation
- eBay image uploads
- eBay AddFixedPriceItem listing creation
- Item-specific inference / retry logic
- Posted-product tracking
- Optional 3-hour worker hook

## What was removed

Only desktop-framework/dependency overhead:

- Electron
- preload.js
- better-sqlite3
- sharp
- dotenv package
- OpenAI npm package
- node_modules

The browser handles local image resizing/conversion, and Node's built-in APIs handle HTTP, files, crypto, FormData, Blob, and fetch.

## Project structure

```text
Ebay-AutoShop-Web/
├── server.js
├── public/
│   └── index.html
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

At runtime the app automatically creates:

```text
data/state.json
```

That file stores AliExpress tokens and posted-product history. It is ignored by Git.

## Requirements

Node.js 20 or newer. Node 24 is recommended.

There are **zero npm dependencies**, so there is no `npm install` step.

## First run

1. Copy `.env.example` to `.env`.
2. Put your existing eBay, AliExpress, and OpenAI credentials in `.env`.
3. You do not set a universal eBay postal code. AutoShop determines the ship-from/item location per AliExpress product/variant when possible, and asks for confirmation when the supplier data is incomplete.
4. Start the server:

```powershell
npm start
```

or:

```powershell
node server.js
```

5. Open:

```text
http://localhost:8080
```

## AliExpress authorization

### If running only on localhost

Set:

```env
PUBLIC_BASE_URL=http://localhost:8080
```

AliExpress may require an HTTPS/public callback depending on your app configuration.

### If using ngrok

Run:

```powershell
ngrok http 8080
```

Copy the HTTPS forwarding URL into `.env:

```env
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.dev
```

Your AliExpress redirect URL is then:

```text
https://your-ngrok-url.ngrok-free.dev/callback
```

Restart the server after changing `.env`, then click **Authorize AliExpress** in the web app.

## GitHub / Codespaces

Commit these files:

```text
server.js
public/index.html
package.json
.env.example
.gitignore
README.md
```

Do **not** commit:

```text
.env
data/
```

Because there are no dependencies, Codespaces does not need `npm install`:

```bash
npm start
```

Expose port `8080` and open the forwarded URL.

For AliExpress OAuth in Codespaces, set `PUBLIC_BASE_URL` to the Codespaces forwarded HTTPS URL and make that callback URL valid in your AliExpress app settings.

## Important eBay note

AliExpress category IDs and eBay category IDs are different. The UI intentionally does not treat an AliExpress category ID as an eBay category ID. Run **Compare on eBay** to get an eBay category suggestion, or enter an eBay category ID manually.

## Runtime state

`data/state.json` is intentionally local/private because it contains OAuth tokens. If you switch computers, authorize AliExpress again on that deployment instead of committing token files to GitHub.


## Product-specific ship-from location

The web app no longer uses a universal `EBAY_POSTAL_CODE`.

For every AliExpress product/variant, AutoShop now:

1. Looks for an explicit AliExpress **Ships From / Ship From / Warehouse** SKU or product field.
2. Uses that location automatically when AliExpress exposes it.
3. If only **Origin** or the seller/store country is available, treats it as a low-confidence candidate rather than claiming it is the warehouse.
4. Requires you to confirm or correct the location before creating the eBay listing when the location is uncertain.
5. Sends eBay:
   - the actual country code, and
   - either a real postal code (if known) or a free-form `Item.Location`.

The default eBay shipping service also changes with the ship-from country:

- US → `USPSGroundAdvantage`
- outside US, fast → `ExpeditedShippingFromOutsideUS`
- outside US, medium → `StandardShippingFromOutsideUS`
- outside US, slower/unknown → `EconomyShippingFromOutsideUS`

You can edit the shipping service and shipping cost before publishing.

This is intentionally conservative: product manufacturing `Origin` is not assumed to be the warehouse location.



### Can this run from GitHub on another device?

The repository itself stores the code; GitHub does not run a Node server just because the files are in a repo.

For browser-based development, open the repo in **GitHub Codespaces**, run:

```bash
npm start
```

and open the forwarded port for `8080`.

Because this is now a web app rather than Electron, you can use the running UI through a browser. For AliExpress OAuth, the callback URL must point at the externally reachable Codespaces/hosted URL and the required API credentials must be provided as environment variables or Codespaces secrets.

For an always-on app, deploy the same repo to a normal Node.js host instead of relying on a development Codespace.

