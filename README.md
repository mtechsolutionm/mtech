# Mtech PC Components Store

Storefront with a local Node.js backend for dealer account approvals and dealer-code sign-in.

## Run on Windows

1. Install Node.js 20.6 or later.
2. In this folder, copy `.env.example` to `.env`.
3. Edit `.env`:
   - Set `ADMIN_PASSWORD` to a unique password with at least 5 characters; a longer password is recommended.
4. In PowerShell, run:

   ```powershell
   npm start
   ```

5. Open `http://localhost:8000/`.

The server serves the website and its API from the same origin. Do not open `index.html` directly or use a static-only preview server for dealer login.

## Dealer accounts

- Dealer sign-up requests are saved in `data/dealer-store.json`.
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
