import AppKit
import Foundation
import Vision

struct TextBox: Codable {
  let text: String
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: ocr-boxes.swift image-path\n", stderr)
  exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: imageURL) else {
  fputs("failed to read image\n", stderr)
  exit(3)
}

var proposedRect = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
  fputs("failed to create CGImage\n", stderr)
  exit(4)
}

let scale = NSScreen.main?.backingScaleFactor ?? 1
let pixelWidth = Double(cgImage.width)
let pixelHeight = Double(cgImage.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

let boxes = (request.results ?? []).compactMap { observation -> TextBox? in
  guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines),
        !text.isEmpty else {
    return nil
  }

  let rect = observation.boundingBox
  return TextBox(
    text: text,
    x: rect.minX * pixelWidth / scale,
    y: (1 - rect.maxY) * pixelHeight / scale,
    width: rect.width * pixelWidth / scale,
    height: rect.height * pixelHeight / scale
  )
}

let data = try JSONEncoder().encode(boxes)
print(String(data: data, encoding: .utf8) ?? "[]")
