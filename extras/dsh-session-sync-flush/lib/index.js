export const name = "dsh-session-sync-flush";

/**
 * 崩溃前一刻日志落盘 —— 关键事件后主动触发 session/flush。
 *
 * 官方语义（DeepSeek Harness persistence）：
 *   - session/event 先进入有界 write-behind buffer，窗口到期才 append；append 是 best-effort，
 *     **只有 flush 才是 durability barrier**；
 *   - 因此崩溃在「请求进行中」会丢当前请求尚未 flush 的 buffer。
 *
 * 本插件把丢失窗口从「整个请求」缩小到「单个事件」：监听关键事件
 * （user/message、assistant/message、tool/call、tool/result），事件落库后立即 flush。
 *
 * 适配桌面端 0.2.x：
 *   - 首选旧接口 `ctx.get("sessions").flush(session)`（0.2.2-rc.1 仍保留）；
 *   - 回退到服务级 durability barrier `ctx.sessionPersistence.flush()`（handle 化后的官方接口）。
 *   - flush 是异步 fire-and-forget，不阻塞生产方；失败只告警，绝不打断会话。
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger("session-sync-flush");

  const flushTypes = new Set(config.flushTypes ?? [
    "user/message",
    "assistant/message",
    "tool/call",
    "tool/result"
  ]);

  function flushNow(session) {
    try {
      const sessions = ctx.get("sessions");
      if (sessions && typeof sessions.flush === "function") {
        return sessions.flush(session);
      }
      const persistence = ctx.get("sessionPersistence");
      if (persistence && typeof persistence.flush === "function") {
        return persistence.flush();
      }
      return Promise.reject(new Error("no flush API on this DSH build"));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  ctx.on("session/event", (session, event) => {
    if (event == null || !flushTypes.has(event.type)) return;
    flushNow(session).catch((error) => {
      logger.warn(`session-sync-flush: flush failed: ${error?.message ?? error}`);
    });
  });
}

export default apply;
