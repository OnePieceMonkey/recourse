import { HealthDot } from "./HealthDot";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p>
          <strong>Sandbox only.</strong> PayPal sandbox, test money, network <code>paypal:sandbox</code>.
        </p>
        <HealthDot />
      </div>
    </footer>
  );
}
