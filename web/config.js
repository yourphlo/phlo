// Web app settings.
window.PHLO_CONFIG = {
  // OAuth client ID from Google Cloud (README > "Web app setup").
  // Leave empty to paste it into the page instead (saved in that browser only).
  clientId: '464272829786-o2pnp64gvtr3u5da9dpfncdd349o07le.apps.googleusercontent.com',
  timeZone: 'America/Los_Angeles',
  // The only Google accounts allowed to use the app. Everyone else is signed straight back out.
  allowedEmails: ['yourphlo@gmail.com'],
  // How the owner signs in: 'password' (the long ADMIN_PASSWORD set in the dispatch script, see
  // apps-script-dispatch/README.md) or 'google' (Google sign-in with the account above).
  ownerLogin: 'password',
  // Google Maps API key for address suggestions on driver profiles (README > "Google Maps addresses").
  // Safe to publish once the key is limited to your website. Leave empty to type addresses by hand.
  mapsApiKey: 'AIzaSyAgKKj2E5yMTIntVmX6ZZttIBq770rx47M',
  // Web app URL of the PHLO dispatch script (apps-script-dispatch/README.md), ending in /exec.
  // Needed to send routes to drivers and for driver sign-in. Leave empty to plan and print routes only.
  dispatchUrl: 'https://script.google.com/macros/s/AKfycbyn2gloAxlEXi9livqO5nHkPWkf0YE895azLgcs9FWTDPnn0_XLqZf1125IcV7zxsel/exec',
};
