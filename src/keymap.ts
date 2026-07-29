import { AndroidKeyCode } from "@yume-chan/scrcpy";

export interface KeyTarget {
  android: (typeof AndroidKeyCode)[keyof typeof AndroidKeyCode];
  adb: string;
}

const byCode: Record<string, KeyTarget> = {
  Backquote: { android: AndroidKeyCode.Backquote, adb: "68" },
  Minus: { android: AndroidKeyCode.Minus, adb: "69" },
  Equal: { android: AndroidKeyCode.Equal, adb: "70" },
  BracketLeft: { android: AndroidKeyCode.BracketLeft, adb: "71" },
  BracketRight: { android: AndroidKeyCode.BracketRight, adb: "72" },
  Backslash: { android: AndroidKeyCode.Backslash, adb: "73" },
  Semicolon: { android: AndroidKeyCode.Semicolon, adb: "74" },
  Quote: { android: AndroidKeyCode.Quote, adb: "75" },
  Comma: { android: AndroidKeyCode.Comma, adb: "55" },
  Period: { android: AndroidKeyCode.Period, adb: "56" },
  Slash: { android: AndroidKeyCode.Slash, adb: "76" },
  Space: { android: AndroidKeyCode.Space, adb: "62" },
  Tab: { android: AndroidKeyCode.Tab, adb: "61" },
  Enter: { android: AndroidKeyCode.Enter, adb: "66" },
  NumpadEnter: { android: AndroidKeyCode.NumpadEnter, adb: "160" },
  Backspace: { android: AndroidKeyCode.Backspace, adb: "67" },
  Delete: { android: AndroidKeyCode.Delete, adb: "112" },
  Escape: { android: AndroidKeyCode.Escape, adb: "111" },
  ArrowUp: { android: AndroidKeyCode.ArrowUp, adb: "19" },
  ArrowDown: { android: AndroidKeyCode.ArrowDown, adb: "20" },
  ArrowLeft: { android: AndroidKeyCode.ArrowLeft, adb: "21" },
  ArrowRight: { android: AndroidKeyCode.ArrowRight, adb: "22" },
  Home: { android: AndroidKeyCode.Home, adb: "122" },
  End: { android: AndroidKeyCode.End, adb: "123" },
  PageUp: { android: AndroidKeyCode.PageUp, adb: "92" },
  PageDown: { android: AndroidKeyCode.PageDown, adb: "93" },
  Insert: { android: AndroidKeyCode.Insert, adb: "124" },
  ShiftLeft: { android: AndroidKeyCode.ShiftLeft, adb: "59" },
  ShiftRight: { android: AndroidKeyCode.ShiftRight, adb: "60" },
  ControlLeft: { android: AndroidKeyCode.ControlLeft, adb: "113" },
  ControlRight: { android: AndroidKeyCode.ControlRight, adb: "114" },
  AltLeft: { android: AndroidKeyCode.AltLeft, adb: "57" },
  AltRight: { android: AndroidKeyCode.AltRight, adb: "58" },
  MetaLeft: { android: AndroidKeyCode.MetaLeft, adb: "117" },
  MetaRight: { android: AndroidKeyCode.MetaRight, adb: "118" },
  CapsLock: { android: AndroidKeyCode.CapsLock, adb: "115" },
  ContextMenu: { android: AndroidKeyCode.ContextMenu, adb: "82" },
  F1: { android: AndroidKeyCode.F1, adb: "131" },
  F2: { android: AndroidKeyCode.F2, adb: "132" },
  F3: { android: AndroidKeyCode.F3, adb: "133" },
  F4: { android: AndroidKeyCode.F4, adb: "134" },
  F5: { android: AndroidKeyCode.F5, adb: "135" },
  F6: { android: AndroidKeyCode.F6, adb: "136" },
  F7: { android: AndroidKeyCode.F7, adb: "137" },
  F8: { android: AndroidKeyCode.F8, adb: "138" },
  F9: { android: AndroidKeyCode.F9, adb: "139" },
  F10: { android: AndroidKeyCode.F10, adb: "140" },
  F11: { android: AndroidKeyCode.F11, adb: "141" },
  F12: { android: AndroidKeyCode.F12, adb: "142" },
  Numpad0: { android: AndroidKeyCode.Numpad0, adb: "144" },
  Numpad1: { android: AndroidKeyCode.Numpad1, adb: "145" },
  Numpad2: { android: AndroidKeyCode.Numpad2, adb: "146" },
  Numpad3: { android: AndroidKeyCode.Numpad3, adb: "147" },
  Numpad4: { android: AndroidKeyCode.Numpad4, adb: "148" },
  Numpad5: { android: AndroidKeyCode.Numpad5, adb: "149" },
  Numpad6: { android: AndroidKeyCode.Numpad6, adb: "150" },
  Numpad7: { android: AndroidKeyCode.Numpad7, adb: "151" },
  Numpad8: { android: AndroidKeyCode.Numpad8, adb: "152" },
  Numpad9: { android: AndroidKeyCode.Numpad9, adb: "153" },
  NumpadAdd: { android: AndroidKeyCode.NumpadAdd, adb: "157" },
  NumpadSubtract: { android: AndroidKeyCode.NumpadSubtract, adb: "156" },
  NumpadMultiply: { android: AndroidKeyCode.NumpadMultiply, adb: "155" },
  NumpadDivide: { android: AndroidKeyCode.NumpadDivide, adb: "154" },
  NumpadDecimal: { android: AndroidKeyCode.NumpadDecimal, adb: "158" },
};

export function mapKeyboardCode(code: string, key: string): KeyTarget | undefined {
  const direct = byCode[code];
  if (direct) {
    return direct;
  }

  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)) {
    const android = AndroidKeyCode[code as keyof typeof AndroidKeyCode];
    if (android !== undefined) {
      return { android, adb: String(android) };
    }
  }

  if (key === "Space") {
    return byCode.Space;
  }

  return undefined;
}
