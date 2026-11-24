export const routeTitles: Readonly<Record<string, string>> = {
  "/": "OracleDesk",
  "/markets": "Markets · OracleDesk",
  "/markets/terminal": "Market Terminal · OracleDesk",
  "/markets/quick-view": "Market · OracleDesk",
  "/market": "Market · OracleDesk",
  "/reasoning": "AI Reasoning · OracleDesk",
  "/reasoning/verify": "Verify Reasoning Trace · OracleDesk",
  "/copy-trade": "Copy Trade · OracleDesk",
  "/portfolio": "Portfolio · OracleDesk",
  "/portfolio/analytics": "Portfolio Analytics · OracleDesk",
  "/portfolio/wallets": "Wallet Assets · OracleDesk",
  "/premium": "Premium · OracleDesk",
  "/premium/trace": "Premium Trace · OracleDesk",
  "/stats": "Statistics · OracleDesk",
  "/admin": "Admin · OracleDesk",
  "/settings": "Settings · OracleDesk",
  "/notifications": "Notifications · OracleDesk",
  "/privacy": "Privacy · OracleDesk",
  "/tx": "Transaction · OracleDesk",
  "/offline": "Offline · OracleDesk",
};

export function titleForPathname(pathname: string): string | null {
  if (routeTitles[pathname]) return routeTitles[pathname];
  if (pathname.startsWith("/agent/")) return "Agent Profile · OracleDesk";
  if (pathname.startsWith("/admin/")) return "Admin · OracleDesk";
  if (pathname.startsWith("/execution-terminal")) return "Execution Terminal · OracleDesk";
  if (pathname.startsWith("/learn/")) return "Learn · OracleDesk";
  if (pathname.startsWith("/transaction-")) return "Transaction Status · OracleDesk";
  return null;
}
