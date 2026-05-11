// Local-only override for window.APP_CONFIG. Loaded after config.js.
// Copy this file to `config.local.js` (which is gitignored) and edit.
// If config.local.js does not exist, the production values from config.js
// are used — so leaving this absent on the Pi is the correct deployment.

// ---- OFFLINE MODE (default) ----
// Placeholder URL/key make Sync.configured() return false, so the app
// runs fully on localStorage with no network calls. Safe for any UI work
// or anything that touches sync queues. PIN is set to "0000" for dev.
window.APP_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-ANON-KEY",
  pin: "0000",
};

// ---- SANDBOX MODE (commented out) ----
// Uncomment and fill in to exercise real sync against a SEPARATE Supabase
// project (apply supabase-schema.sql there first). Only use when you
// specifically need to test sync code paths. DO NOT paste production
// credentials here — that defeats the whole point of this file.
//
// window.APP_CONFIG = {
//   supabaseUrl: "https://your-sandbox-project.supabase.co",
//   supabaseAnonKey: "your-sandbox-anon-key",
//   pin: "0000",
// };
