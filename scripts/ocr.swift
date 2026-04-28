import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: ocr.swift image-path\n", stderr)
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

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

let observations = (request.results ?? []).sorted { left, right in
  let dy = abs(left.boundingBox.midY - right.boundingBox.midY)
  if dy > 0.015 { return left.boundingBox.midY > right.boundingBox.midY }
  return left.boundingBox.minX < right.boundingBox.minX
}

let lines = observations.compactMap { observation in
  observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
}.filter { !$0.isEmpty }

print(lines.joined(separator: "\n"))
