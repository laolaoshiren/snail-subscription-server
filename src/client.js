"use strict";

function usage() {
  console.log("Usage:");
  console.log("  node src/client.js create [type] [inviteCode] [serverUrl]");
  console.log("  node src/client.js latest [type] [serverUrl]");
  console.log("");
  console.log("Environment:");
  console.log("  SERVER_URL=http://127.0.0.1:3000");
  console.log("  PANEL_PASSWORD=admin");
}

async function login(serverUrl) {
  const password = process.env.PANEL_PASSWORD || "admin";

  const response = await fetch(`${serverUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Login failed.");
  }

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Login succeeded but no session cookie was returned.");
  }

  return setCookie.split(";")[0];
}

async function main() {
  const [action = "latest", type = "full", thirdArg = "", fourthArg = ""] = process.argv.slice(2);
  const serverUrl =
    action === "create"
      ? fourthArg || process.env.SERVER_URL || "http://127.0.0.1:3000"
      : thirdArg || process.env.SERVER_URL || "http://127.0.0.1:3000";
  const inviteCode = action === "create" ? thirdArg : "";

  if (!["create", "latest"].includes(action)) {
    usage();
    process.exit(1);
  }

  const cookie = await login(serverUrl);

  const endpoint =
    action === "create"
      ? `${serverUrl}/api/subscriptions`
      : `${serverUrl}/api/subscriptions/latest?type=${encodeURIComponent(type)}`;

  const response = await fetch(endpoint, {
    method: action === "create" ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body:
      action === "create"
        ? JSON.stringify({
            type,
            inviteCode,
          })
        : undefined,
  });

  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(`Client request failed: ${error.message}`);
  process.exit(1);
});
