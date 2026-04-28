import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
  fputs("usage: click.swift <x> <y>\n", stderr)
  exit(2)
}

let point = CGPoint(x: x, y: y)
let source = CGEventSource(stateID: .combinedSessionState)

if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
  move.post(tap: .cghidEventTap)
}
usleep(20_000)
if let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
  down.post(tap: .cghidEventTap)
}
usleep(50_000)
if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
  up.post(tap: .cghidEventTap)
}
