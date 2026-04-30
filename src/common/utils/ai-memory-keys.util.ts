export function buildStrategicChatMemoryKey(companyId: string, userId: string) {
  return `memory:${companyId}:user:${userId}`;
}

export function buildWhatsappMemoryKey(companyId: string, remoteJid: string) {
  return `memory:${companyId}:whatsapp:${remoteJid}`;
}

export function buildAgentKey(companyId: string) {
  return `agent:${companyId}`;
}

export function buildUsageKey(companyId: string, yyyyMM: string) {
  return `usage:${companyId}:${yyyyMM}`;
}

export function buildBufferKey(companyId: string, remoteJid: string) {
  return `buffer:${companyId}:${remoteJid}`;
}

export function buildBufferLastKey(companyId: string, remoteJid: string) {
  return `buffer:last:${companyId}:${remoteJid}`;
}

export function buildHumanPauseKey(companyId: string, remoteJid: string) {
  return `paused:${companyId}:${remoteJid}`;
}
