# Three in a Row

A mobile-friendly tic-tac-toe game with local practice and online matches with a friend.

## Run locally

Requires Node.js 18 or newer.

```sh
npm install
npm start
```

Open <http://localhost:3000>. Run the test suite with `npm test`.

## Deploy to Render

The repository includes a Render Blueprint at [`render.yaml`](./render.yaml). It creates a Docker-based web service in Frankfurt, checks `/health`, and uses Render's free instance plan.

1. Push the project to a GitHub repository.
2. Sign in to [Render](https://dashboard.render.com), choose **New → Blueprint**, and connect the repository.
3. Review the `three-in-a-row` service and deploy the Blueprint.
4. Open the HTTPS `onrender.com` URL Render provides. Test by creating a match in one browser and joining it from another.

Render supports WebSockets on web services. The browser automatically uses secure WebSockets (`wss`) when served over HTTPS.

### Free-plan limits

Render's free web services can spin down after 15 minutes without inbound traffic, including WebSocket traffic. A sleeping service takes time to wake up, and restarts end active matches because room state is held in server memory. Use the deployment for testing; for more reliable play, upgrade to a paid always-on instance. Do not run multiple instances because they do not share match state.

## Docker

Build and run the same image used by Render:

```sh
docker build -t three-in-a-row .
docker run --rm -p 3000:3000 three-in-a-row
```

The server listens on the `PORT` environment variable (default `3000`) and exposes `/health` for service health checks.
