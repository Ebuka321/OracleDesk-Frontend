import { StaticRedirect } from "@/components/static-redirect";

export default function TransactionFailedRedirect() {
  return <StaticRedirect to="/tx" title="Transaction Failed" />;
}
