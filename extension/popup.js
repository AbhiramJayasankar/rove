const $ = (id) => document.getElementById(id);
let busy = false;
async function refresh() {
  if (busy) return;
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    $("status").textContent = state.connected
      ? "Browser connected"
      : state.enabled
        ? "Waiting for Relay"
        : "Browser disconnected";
    $("dot").classList.toggle("connected", !!state.connected);
    $("detail").textContent = state.connected
      ? `${state.attachedTabs.length} attached ${state.attachedTabs.length === 1 ? "tab" : "tabs"}. Your agent can now use this Chrome profile.`
      : state.enabled
        ? "Keep Relay running on this computer. The bridge reconnects automatically."
        : "Start Relay, then paste its pairing token below.";
    $("disconnect").disabled = !state.enabled;
    if (state.error) $("error").textContent = state.error;
  } catch (error) {
    $("error").textContent = error.message;
  }
}
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy = true;
  $("connect").disabled = true;
  $("error").textContent = "";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "configure",
      serverUrl: $("server").value,
      pairingToken: $("token").value,
    });
    if (result.error) throw new Error(result.error);
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    busy = false;
    $("connect").disabled = false;
    await refresh();
  }
});
$("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  $("error").textContent = "";
  await refresh();
});
chrome.storage.local.get(["serverUrl", "pairingToken"]).then((settings) => {
  $("server").value = settings.serverUrl || "ws://127.0.0.1:4789";
  $("token").value = settings.pairingToken || "";
});
refresh();
setInterval(refresh, 1000);
