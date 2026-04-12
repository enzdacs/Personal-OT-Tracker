// =============================================
// firebase-config.js
// Replace these values with YOUR Firebase project config.
// Get them from: Firebase Console → Project Settings → General → Your apps
// =============================================

const firebaseConfig = {
  apiKey: "AIzaSyDH5AIiB04Phvx2o9UCow4vx3SAfkBZjkc",
  authDomain: "otracker-85678.firebaseapp.com",
  projectId: "otracker-85678",
  storageBucket: "otracker-85678.firebasestorage.app",
  messagingSenderId: "928293449995",
  appId: "1:928293449995:web:2c630665b50177af91f20e"
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
      console.warn("⚠️ Persistence failed — multiple tabs open. Data will sync when only one tab is open.");
    } else if (err.code === 'unimplemented') {
      console.warn("⚠️ Offline persistence not supported in this browser.");
    }
  });
