// =============================================
// firebase-config.example.js
// Copy this file to firebase-config.js and fill in your own Firebase project values.
// Get them from: Firebase Console → Project Settings → General → Your apps
//
// ⚠️  DO NOT commit firebase-config.js to version control.
//     Only this example file should be in your repository.
// =============================================

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db   = firebase.firestore();

// ── Enable offline persistence (works without WiFi!) ──
db.enablePersistence({ synchronizeTabs: true })
  .then(() => console.log("✅ Offline persistence enabled"))
  .catch(err => {
    if (err.code === 'failed-precondition') {
      console.warn("⚠️ Persistence failed — multiple tabs open.");
    } else if (err.code === 'unimplemented') {
      console.warn("⚠️ Offline persistence not supported in this browser.");
    }
  });
