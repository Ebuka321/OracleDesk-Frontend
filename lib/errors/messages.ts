import enCatalog from "@/lib/i18n/messages/en.json";
import type { ErrorCode } from "./codes";

interface CatalogShape {
  errors: {
    kind: Record<string, string>;
    contract: Record<string, Record<string, string>>;
    api: Record<string, string>;
  };
}

const catalog: CatalogShape = enCatalog;

/**
 * Resolves a catalog error message for a given stable ErrorCode and interpolates
 * parameters. Supports simple {var} placeholders and ICU-style plural forms
 * like `{seconds, plural, one {# second} other {# seconds}}`.
 */
export function messageFor(
  code: ErrorCode | string,
  params?: Record<string, string | number | undefined>,
): string {
  const parts = code.split(".");
  const domain = parts[0];
  let template: string | undefined;

  if (domain === "kind" && parts[1]) {
    template = catalog.errors.kind[parts[1]];
  } else if (domain === "contract" && parts[1] && parts[2]) {
    const contractName = parts[1];
    const errorName = parts.slice(2).join(".");
    template = catalog.errors.contract[contractName]?.[errorName];
    if (!template) {
      template = `The contract rejected this (${errorName}).`;
    }
  } else if (domain === "api" && parts[1]) {
    template = catalog.errors.api[parts[1]];
    if (!template) {
      template = catalog.errors.api.HTTP_UNKNOWN;
    }
  }

  if (!template) {
    template = catalog.errors.kind.unknown;
  }

  return interpolate(template, params);
}

function interpolate(
  template: string,
  params?: Record<string, string | number | undefined>,
): string {
  // First, resolve plural blocks: {param, plural, one {pattern1} other {pattern2}}
  const pluralRegex = /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g;
  let text = template.replace(pluralRegex, (_match, varName, onePattern, otherPattern) => {
    const val = params?.[varName];
    if (val === undefined || val === null) {
      return "a moment";
    }
    const num = Number(val);
    const pattern = num === 1 ? onePattern : otherPattern;
    return pattern.replace(/#/g, String(num));
  });

  // Next, simple {var} replacements
  const varRegex = /\{(\w+)\}/g;
  text = text.replace(varRegex, (match, varName) => {
    const val = params?.[varName];
    return val !== undefined && val !== null ? String(val) : match;
  });

  return text;
}
