# Ayantha x MD — All-in-One

Pair site + Admin + WhatsApp bot in one Railway service.

## Railway setup

### Required variable
Add this in **Railway → Service → Variables**:

```text
MONGODB_URL=mongodb+srv://USERNAME:PASSWORD@YOUR-CLUSTER.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
```

Optional:

```text
ADMIN_PASSWORD=your-new-admin-password
```

Do **not** put MongoDB credentials inside `index.js` or commit them to GitHub.

## Deploy

Railway detects the Node app and runs:

```text
npm start
```

The server listens on Railway's `PORT` and `0.0.0.0`.

## Health check

Open:

```text
/ping
```

It returns HTTP status, bot count, MongoDB state and uptime.

## Important

The HTTP server now starts before MongoDB. If MongoDB is temporarily unavailable, the website remains reachable instead of immediately returning Railway 502. MongoDB is retried automatically every 15 seconds.

If MongoDB is unavailable, database-dependent pairing/admin actions return a temporary 503 until the database reconnects.
