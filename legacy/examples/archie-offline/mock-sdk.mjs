// Offline response double for Archie's existing SDK import, not an alternate agent.
let reply;
const requests = [];
export function configureReply(markdown) {
  reply = markdown;
}
export function recordedRequests() {
  return [...requests];
}
export class GoogleGenerativeAI {
  constructor(key) {
    if (key !== "archie-offline-fake-key") throw new Error("Only fake credentials are accepted.");
  }
  getGenerativeModel(settings) {
    return {
      async generateContent(prompt) {
        if (typeof reply !== "string") throw new Error("No explicit offline response.");
        requests.push({ settings, prompt });
        return { response: { text: () => reply } };
      },
    };
  }
}
