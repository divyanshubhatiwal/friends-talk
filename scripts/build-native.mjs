// Builds the `www/` bundle that Capacitor wraps into the native app.
//
// Three things differ from the web build:
//
//   1. The socket.io client is normally served by the server at
//      /socket.io/socket.io.js. A native shell has no server at its own origin,
//      so the client library is copied in and referenced locally.
//
//   2. config.js is rewritten with the deployed server's HTTPS origin. Without
//      it the app loads and then silently fails to connect to anything.
//
//   3. The app — not the marketing page — becomes index.html. Launching a
//      native app onto a landing page with a "Start talking" button is the kind
//      of thing App Review calls out as a repackaged website.

import { cp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const www = path.join(root, 'www');

// A native build has no server at its own origin, so it must be told where the
// deployed backend lives. Defaults to the production site; override with
// NATIVE_SERVER_URL (IOS_SERVER_URL is still honoured) for a staging server.
const serverUrl = (process.env.NATIVE_SERVER_URL || process.env.IOS_SERVER_URL ||
  'https://friendstalk.fun').replace(/\/+$/, '');

if (!serverUrl.startsWith('https://')) {
  console.error(
    `\nNATIVE_SERVER_URL must be https:// — got "${serverUrl}".\n\n` +
    'Both platforms block cleartext HTTP by default, and getUserMedia\n' +
    'requires a secure context. A plain http:// origin will not work on device.\n'
  );
  process.exit(1);
}

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

// 1. Copy the web assets.
await cp(path.join(root, 'public'), www, { recursive: true });

// 2. Vendor the socket.io browser client.
await mkdir(path.join(www, 'js', 'vendor'), { recursive: true });
await copyFile(
  path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'),
  path.join(www, 'js', 'vendor', 'socket.io.min.js')
);

// 3. Point the client at the deployed server.
const configPath = path.join(www, 'js', 'config.js');
const config = await readFile(configPath, 'utf8');
await writeFile(
  configPath,
  config.replace("serverUrl: ''", `serverUrl: ${JSON.stringify(serverUrl)}`)
);

// 4. Rewrite the script tag and make the app the entry point.
const appPath = path.join(www, 'app.html');
let app = await readFile(appPath, 'utf8');
app = app.replace('/socket.io/socket.io.js', '/js/vendor/socket.io.min.js');

// Absolute asset paths resolve fine under capacitor://localhost, but the
// marketing links would strand a user inside the app with no way back.
app = app.replace('<a class="brand" href="/">', '<a class="brand" href="#" onclick="return false">');

// The web server adds ".html" for /terms and /privacy; the app's built-in file
// server does not, so the legal links must name the file.
app = app.replaceAll('href="/terms"', 'href="/terms.html"').replaceAll('href="/privacy"', 'href="/privacy.html"');

await writeFile(path.join(www, 'index.html'), app);
await rm(appPath);

// The marketing pages are not shipped inside the app; the legal pages are,
// because App Review requires them reachable and they must work offline.
for (const page of ['about.html']) {
  await rm(path.join(www, page), { force: true });
}

console.log(`Built ${path.relative(root, www)}/ for native packaging`);
console.log(`  server:     ${serverUrl}`);
console.log('  entry:      index.html (the app)');
console.log('  socket.io:  vendored locally');
console.log('\nNext:  npx cap sync android   (or, on macOS, npx cap sync ios)');
