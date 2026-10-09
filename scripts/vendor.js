// Copies the LiveKit browser build into public/vendor so the page serves it itself (no third-party scripts).
// Vercel's CDN serves only public/, so the copy is committed. Re-run after upgrading livekit-client.
import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('public/vendor', { recursive: true });
copyFileSync('node_modules/livekit-client/dist/livekit-client.umd.js', 'public/vendor/livekit-client.umd.js');
console.log('Copied livekit-client.umd.js to public/vendor/');
