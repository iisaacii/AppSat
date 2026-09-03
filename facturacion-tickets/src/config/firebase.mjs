import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEnv, getFirebaseStorageBucketName } from "./env.mjs";

export function getFirebaseDb() {
  initializeFirebaseApp();
  return getFirestore();
}

export function getFirebaseStorageBucket() {
  initializeFirebaseApp();
  return getStorage().bucket(getFirebaseStorageBucketName());
}

export function getFirebaseAuth() {
  initializeFirebaseApp();
  return getAuth();
}

function initializeFirebaseApp() {
  if (getApps().length) {
    return;
  }

  const emulatorMode = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST,
  );

  initializeApp({
    ...(emulatorMode ? {} : { credential: getCredential() }),
    projectId: getEnv("FIREBASE_PROJECT_ID"),
    storageBucket: getFirebaseStorageBucketName(),
  });
}

function getCredential() {
  const credentialsPath = getEnv("GOOGLE_APPLICATION_CREDENTIALS");

  if (credentialsPath) {
    const resolvedPath = resolve(credentialsPath);
    if (existsSync(resolvedPath)) {
      const serviceAccount = JSON.parse(readFileSync(resolvedPath, "utf8"));
      return cert(serviceAccount);
    }
  }

  return applicationDefault();
}
