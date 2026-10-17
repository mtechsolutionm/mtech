# Mtech PC Components Store

Storefront with a local Node.js backend for dealer account approvals and dealer-code sign-in.

## Run on Windows

1. Install Node.js 20.6 or later.
2. In this folder, copy `.env.example` to `.env`.
3. Edit `.env`:
   - Set `ADMIN_PASSWORD` to a unique password with at least 5 characters; a longer password is recommended.
   - Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from your Razorpay dashboard. Start with test-mode keys; use live keys only after enabling live payments.
4. In PowerShell, run:

   ```powershell
   npm start
   ```

5. Open `http://localhost:8000/`.
6. Open `http://localhost:8000/admin` for the separate Admin page. It uses the same server, admin sign-in, APIs, and saved data as the storefront.

The server serves the website and its API from the same origin. Do not open `index.html` or `admin.html` directly from File Explorer, or use a static-only preview server for sign-in.

## Dealer accounts

- Dealer sign-up requests are saved in `data/dealer-store.json`.
- Products, categories, and subcategories are saved in `data/catalog-store.json` when changed by an authenticated admin. Newly added categories and product subcategories are included in the catalog automatically.
- Customer accounts and orders are saved in `data/order-store.json`. Customer passwords are stored as salted scrypt hashes, not plain text.
- The admin Dashboard shows each product's stock, units reserved by pending orders, and remaining available stock. Pending orders reserve stock; marking an order completed deducts stock and assigns available license keys. Completed orders cannot be reopened.
- Customer registration/login, checkout, customer order history, and admin order management require the local server. Customer and admin sessions are held in memory and end when the server restarts.
- Checkout supports Cash on Delivery, bank transfer, and Razorpay-hosted UPI, card, and net-banking payments. Razorpay payments are confirmed by the server before an order is saved as paid.
- Razorpay API secrets must stay in `.env` and must never be added to `index.html` or committed to Git. Online payment requires valid Razorpay keys; COD and bank transfer remain available without them.
- Sign in is enabled after admin approval.
- Dealers sign in with their registered email and dealer code. No OTP or external email/SMS provider is needed.
- Admin approval generates a dealer code, which is shown in the Admin panel to share with the dealer.
- The Dealer Sign In screen has only the **Sign In with Dealer Code** option.
- Admin login uses the password configured in `ADMIN_PASSWORD`.
- Dealer requests, approvals, and dealer records are shared by browsers that connect to this server.
- Dealer data is local to this PC. Other users can reach it only if the server is hosted and securely exposed to them.

## Security and hosting

- Keep `.env` private. It is excluded from Git. Never put secrets in `index.html` or share them in chat.
- The sample server binds to the IPv6 loopback address `::1`, so it is for local testing on this PC. Do not expose this server to the public internet as-is; public use needs HTTPS, secure deployment, persistent session/rate-limit storage, backups, and production hosting.
- Admin sessions are held in server memory and are invalidated when the server restarts.
