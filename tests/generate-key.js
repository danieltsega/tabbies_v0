// Utility to generate a deterministic Chrome Extension key pair and calculate the Extension ID.
const crypto = require("crypto");

function generateKeyPair() {
  // Generate RSA key pair
  const { publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "der"
    }
  });

  // Base64 encode the public key
  const publicKeyBase64 = publicKey.toString("base64");

  // Calculate the extension ID
  // 1. SHA-256 hash of the public key DER buffer
  const hash = crypto.createHash("sha256").update(publicKey).digest("hex");
  
  // 2. Take first 32 hex chars and map 0-f to a-p
  const first32 = hash.substring(0, 32);
  let id = "";
  for (let i = 0; i < first32.length; i++) {
    const code = first32.charCodeAt(i);
    if (code >= 48 && code <= 57) { // '0'-'9'
      id += String.fromCharCode(code + 49); // '0' -> 'a', '1' -> 'b', etc.
    } else if (code >= 97 && code <= 102) { // 'a'-'f'
      id += String.fromCharCode(code + 10); // 'a' -> 'k', 'b' -> 'l', etc.
    }
  }

  console.log("--- ADD TO MANIFEST.JSON ---");
  console.log(`"key": "${publicKeyBase64}"`);
  console.log("\n--- CORRESPONDING EXTENSION ID ---");
  console.log(id);
}

generateKeyPair();
