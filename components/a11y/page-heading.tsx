import type { ComponentPropsWithoutRef } from "react";

export function PageHeading({ children, className = "", ...props }: ComponentPropsWithoutRef<"h1">) {
  return (
    <h1
      {...props}
      tabIndex={-1}
      data-route-heading
      className={`outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${className}`}
    >
      {children}
    </h1>
  );
}
