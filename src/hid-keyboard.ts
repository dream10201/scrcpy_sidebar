// Standard USB HID boot keyboard: 8-byte input report
// [modifier bitmask, reserved, key1..key6].
export const HidKeyboardDescriptor = new Uint8Array([
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x06, // Usage (Keyboard)
  0xa1, 0x01, // Collection (Application)
  0x05, 0x07, //   Usage Page (Keyboard)
  0x19, 0xe0, //   Usage Minimum (Left Control)
  0x29, 0xe7, //   Usage Maximum (Right GUI)
  0x15, 0x00, //   Logical Minimum (0)
  0x25, 0x01, //   Logical Maximum (1)
  0x75, 0x01, //   Report Size (1)
  0x95, 0x08, //   Report Count (8)
  0x81, 0x02, //   Input (Data, Variable, Absolute): modifiers
  0x75, 0x08, //   Report Size (8)
  0x95, 0x01, //   Report Count (1)
  0x81, 0x01, //   Input (Constant): reserved byte
  0x05, 0x08, //   Usage Page (LEDs)
  0x19, 0x01, //   Usage Minimum (Num Lock)
  0x29, 0x05, //   Usage Maximum (Kana)
  0x75, 0x01, //   Report Size (1)
  0x95, 0x05, //   Report Count (5)
  0x91, 0x02, //   Output (Data, Variable, Absolute): LEDs
  0x75, 0x03, //   Report Size (3)
  0x95, 0x01, //   Report Count (1)
  0x91, 0x01, //   Output (Constant): padding
  0x05, 0x07, //   Usage Page (Keyboard)
  0x19, 0x00, //   Usage Minimum (0)
  0x29, 0x65, //   Usage Maximum (101)
  0x15, 0x00, //   Logical Minimum (0)
  0x25, 0x65, //   Logical Maximum (101)
  0x75, 0x08, //   Report Size (8)
  0x95, 0x06, //   Report Count (6)
  0x81, 0x00, //   Input (Data, Array): keys
  0xc0, //       End Collection
]);

export const UHidKeyboardId = 1;

const modifierBits: Record<string, number> = {
  ControlLeft: 1 << 0,
  ShiftLeft: 1 << 1,
  AltLeft: 1 << 2,
  MetaLeft: 1 << 3,
  ControlRight: 1 << 4,
  ShiftRight: 1 << 5,
  AltRight: 1 << 6,
  MetaRight: 1 << 7,
};

// KeyboardEvent.code -> HID usage id (Usage Page 0x07).
const hidUsageByCode: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad1: 0x59,
  Numpad2: 0x5a,
  Numpad3: 0x5b,
  Numpad4: 0x5c,
  Numpad5: 0x5d,
  Numpad6: 0x5e,
  Numpad7: 0x5f,
  Numpad8: 0x60,
  Numpad9: 0x61,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
  IntlBackslash: 0x64,
  ContextMenu: 0x65,
};

function hidUsageFor(code: string): number | undefined {
  const direct = hidUsageByCode[code];
  if (direct !== undefined) {
    return direct;
  }
  if (/^Key[A-Z]$/.test(code)) {
    return 0x04 + code.charCodeAt(3) - 0x41;
  }
  if (/^Digit[1-9]$/.test(code)) {
    return 0x1e + code.charCodeAt(5) - 0x31;
  }
  if (code === "Digit0") {
    return 0x27;
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return 0x3a + Number(code.slice(1)) - 1;
  }
  return undefined;
}

const MaxPressedKeys = 6;

export class HidKeyboard {
  private modifiers = 0;
  private pressed: number[] = [];

  // Returns the next 8-byte input report, or undefined when the key
  // cannot be represented by this HID keyboard.
  handleKey(code: string, action: "down" | "up"): Uint8Array | undefined {
    const modifierBit = modifierBits[code];
    if (modifierBit !== undefined) {
      if (action === "down") {
        this.modifiers |= modifierBit;
      } else {
        this.modifiers &= ~modifierBit;
      }
      return this.buildReport();
    }

    const usage = hidUsageFor(code);
    if (usage === undefined) {
      return undefined;
    }

    if (action === "down") {
      if (!this.pressed.includes(usage)) {
        if (this.pressed.length >= MaxPressedKeys) {
          this.pressed.shift();
        }
        this.pressed.push(usage);
      }
    } else {
      this.pressed = this.pressed.filter((key) => key !== usage);
    }
    return this.buildReport();
  }

  reset(): Uint8Array {
    this.modifiers = 0;
    this.pressed = [];
    return this.buildReport();
  }

  private buildReport(): Uint8Array {
    const report = new Uint8Array(8);
    report[0] = this.modifiers;
    for (let index = 0; index < this.pressed.length; index += 1) {
      report[2 + index] = this.pressed[index];
    }
    return report;
  }
}
