/* Where the client should reach the server.
 *
 * On the web this stays empty: the page and the API share an origin, so
 * socket.io and fetch resolve correctly on their own.
 *
 * Native builds are different. Capacitor serves the bundled assets from
 * capacitor://localhost, which is the app itself and not a server — a
 * same-origin connection there reaches nothing. Native builds must point at
 * the deployed HTTPS origin explicitly.
 *
 * `npm run build:ios` rewrites this file from the IOS_SERVER_URL environment
 * variable, so the committed value stays empty and the web build is unaffected.
 */

window.FRIENDSTALK = {
  serverUrl: '',

  // Native shells report themselves here so the UI can adapt (a phone has no
  // hover, and the notch needs safe-area padding).
  get isNative() {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  }
};
