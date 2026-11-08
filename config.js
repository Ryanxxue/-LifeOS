/* 公开配置：这些值会出现在前端，本身不含权限。Origin 可以伪造，真正的隔离边界
   是数据库的 RLS + 用户 JWT（owner_id = auth.uid()），不要把前端校验当安全边界。 */
window.APP_CONFIG = {
  cloud: {
    endpoint: "https://life-board-97391.app.workbuddy.host",
    oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
    publishableKey: "wbpk_Z6y3mkx1HWkRNCsS9H9pA6_EVz9WV6KX29gxacPsVmyHqHt6u35J6tw"
  },
  coros: {
    base: "https://mcpcn.coros.com",
    redirectUri: "https://life-board-97391.app.workbuddy.host/",
    clientName: "生活记录面板"
  }
};
