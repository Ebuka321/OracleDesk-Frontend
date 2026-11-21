// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrKey } from "@stellar/stellar-sdk";
import { AddressInput } from "../address-input";
import type { KnownAddress } from "@/lib/stellar/address-policy";

function makeAccount(seed: number): string {
  const bytes = new Uint8Array(32).fill(seed & 0xff);
  bytes[0] = (seed >> 8) & 0xff;
  bytes[1] = seed & 0xff;
  return StrKey.encodeEd25519PublicKey(Buffer.from(bytes));
}

describe("AddressInput", () => {
  const knownAddr = makeAccount(10);
  const freshAddr = makeAccount(20);
  const known: KnownAddress[] = [{ address: knownAddr, label: "Trusted", source: "book" }];

  it("strips whitespace and zero-width characters on paste and reports what was removed", () => {
    const onChange = vi.fn();
    render(
      <AddressInput
        value=""
        onChange={onChange}
        policy="watch"
        known={known}
        ariaLabel="Address"
      />,
    );
    const input = screen.getByLabelText("Address");
    fireEvent.paste(input, {
      clipboardData: { getData: () => ` ${knownAddr.slice(0, 10)}\u200B${knownAddr.slice(10)} ` },
    });
    expect(onChange).toHaveBeenCalledWith(knownAddr);
    expect(screen.getByText(/Removed 3 whitespace or zero-width characters on paste/i)).toBeTruthy();
  });

  it("requires explicit confirmation for first-time authority addresses before emitting", () => {
    const onValidated = vi.fn();
    render(
      <AddressInput
        value={freshAddr}
        onChange={() => {}}
        onValidated={onValidated}
        policy="authority"
        expect="account"
        known={known}
        ariaLabel="Authority address"
      />,
    );

    expect(onValidated).toHaveBeenLastCalledWith(null);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onValidated).toHaveBeenLastCalledWith(freshAddr);
  });

  it("requires re-typing the last 8 characters for look-alike authority addresses and announces via LiveRegion", () => {
    // Generate a real valid keypair or mock classify? Let's craft a known entry that shares 5 prefix chars with freshAddr!
    const lookalikeOf: KnownAddress = {
      address: freshAddr.slice(0, 6) + "AAAAAA" + freshAddr.slice(12),
      label: "Victim",
      source: "book",
    };
    const onValidated = vi.fn();
    render(
      <AddressInput
        value={freshAddr}
        onChange={() => {}}
        onValidated={onValidated}
        policy="authority"
        expect="account"
        known={[lookalikeOf]}
        ariaLabel="Authority address"
      />,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/look-alike address matches Victim/i);
    expect(onValidated).toHaveBeenLastCalledWith(null);

    const retype = screen.getByPlaceholderText("Last 8 characters");
    fireEvent.change(retype, { target: { value: freshAddr.slice(-8) } });
    expect(onValidated).toHaveBeenLastCalledWith(freshAddr);
  });
});
