import AppKit

final class LauncherController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var runner: Process?
    private var intentionalExit = false
    private var stdoutBuffer = ""

    private let statusLabel = NSTextField(labelWithString: "正在启动服务...")
    private let phoneField = NSTextField(labelWithString: "准备中")
    private let localField = NSTextField(labelWithString: "准备中")
    private let tokenField = NSTextField(labelWithString: "准备中")
    private let detailField = NSTextField(labelWithString: "首次运行可能会弹出配置窗口，请按提示完成设置。")
    private let openButton = NSButton(title: "打开本机页面", target: nil, action: nil)
    private let copyButton = NSButton(title: "复制手机地址", target: nil, action: nil)
    private let quitButton = NSButton(title: "停止并退出", target: nil, action: nil)

    private var phoneURL = ""
    private var localURL = "http://localhost:8088"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        launchRunner()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminateRunner()
    }

    func windowWillClose(_ notification: Notification) {
        intentionalExit = true
        terminateRunner()
        NSApp.terminate(nil)
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex Mobile Remote"
        window.minSize = NSSize(width: 620, height: 420)
        window.center()
        window.delegate = self

        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        window.contentView = root

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 22
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 30),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor, constant: -30)
        ])

        let title = NSTextField(labelWithString: "Codex Mobile Remote")
        title.font = .systemFont(ofSize: 28, weight: .semibold)
        title.textColor = .labelColor
        stack.addArrangedSubview(title)

        statusLabel.font = .systemFont(ofSize: 19, weight: .semibold)
        statusLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(statusLabel)

        let info = NSStackView()
        info.orientation = .vertical
        info.alignment = .leading
        info.spacing = 14
        info.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(info)

        info.addArrangedSubview(row(title: "手机访问地址", field: phoneField))
        info.addArrangedSubview(row(title: "本机页面", field: localField))
        info.addArrangedSubview(row(title: "手机登录口令", field: tokenField))

        detailField.font = .systemFont(ofSize: 15)
        detailField.textColor = .secondaryLabelColor
        detailField.lineBreakMode = .byWordWrapping
        detailField.maximumNumberOfLines = 0
        stack.addArrangedSubview(detailField)
        detailField.widthAnchor.constraint(lessThanOrEqualToConstant: 660).isActive = true

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.alignment = .centerY
        buttons.spacing = 14
        stack.addArrangedSubview(buttons)

        configureButton(openButton, isDefault: true, action: #selector(openLocalPage))
        configureButton(copyButton, isDefault: false, action: #selector(copyPhoneURL))
        configureButton(quitButton, isDefault: false, action: #selector(stopAndQuit))

        buttons.addArrangedSubview(quitButton)
        buttons.addArrangedSubview(copyButton)
        buttons.addArrangedSubview(openButton)

        window.makeKeyAndOrderFront(nil)
    }

    private func row(title: String, field: NSTextField) -> NSView {
        let container = NSStackView()
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = 5

        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .secondaryLabelColor

        field.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        field.textColor = .labelColor
        field.isSelectable = true
        field.lineBreakMode = .byTruncatingMiddle

        container.addArrangedSubview(label)
        container.addArrangedSubview(field)
        field.widthAnchor.constraint(lessThanOrEqualToConstant: 660).isActive = true
        return container
    }

    private func configureButton(_ button: NSButton, isDefault: Bool, action: Selector) {
        button.target = self
        button.action = action
        button.bezelStyle = .rounded
        button.controlSize = .large
        if isDefault {
            button.keyEquivalent = "\r"
        }
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 132).isActive = true
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
    }

    private func launchRunner() {
        let bundleURL = Bundle.main.bundleURL
        let runnerURL = bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("Resources")
            .appendingPathComponent("codex-mobile-remote-runner")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [runnerURL.path, "--native-runner"]

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self?.consumeStdout(text)
        }

        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.detailField.stringValue = text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if !self.intentionalExit {
                    self.statusLabel.stringValue = "服务已停止"
                    self.statusLabel.textColor = .systemRed
                    self.detailField.stringValue = "后台服务已经退出。你可以关闭窗口后重新打开 App。"
                }
            }
        }

        do {
            try process.run()
            runner = process
        } catch {
            statusLabel.stringValue = "启动失败"
            statusLabel.textColor = .systemRed
            detailField.stringValue = "无法启动后台 helper：\(error.localizedDescription)"
        }
    }

    private func consumeStdout(_ chunk: String) {
        stdoutBuffer += chunk
        while let newline = stdoutBuffer.firstIndex(of: "\n") {
            let line = String(stdoutBuffer[..<newline])
            stdoutBuffer.removeSubrange(...newline)
            handleRunnerLine(line)
        }
    }

    private func handleRunnerLine(_ line: String) {
        guard line.hasPrefix("CMR_READY\t") else { return }
        let parts = line.components(separatedBy: "\t")
        guard parts.count >= 5 else { return }

        DispatchQueue.main.async {
            self.phoneURL = parts[1]
            self.localURL = parts[2]
            self.statusLabel.stringValue = "服务正在运行。"
            self.statusLabel.textColor = .systemGreen
            self.phoneField.stringValue = parts[1]
            self.localField.stringValue = parts[2]
            self.tokenField.stringValue = parts[3]
            self.detailField.stringValue = "关闭这个 App 窗口，或点击“停止并退出”，服务就会关闭。日志：\(parts[4])"
        }
    }

    private func terminateRunner() {
        guard let runner, runner.isRunning else { return }
        runner.terminate()
        DispatchQueue.global(qos: .utility).async {
            Thread.sleep(forTimeInterval: 1.2)
            if runner.isRunning {
                runner.interrupt()
            }
        }
    }

    @objc private func openLocalPage() {
        guard let url = URL(string: localURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func copyPhoneURL() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(phoneURL.isEmpty ? phoneField.stringValue : phoneURL, forType: .string)
        detailField.stringValue = "手机访问地址已复制。"
    }

    @objc private func stopAndQuit() {
        intentionalExit = true
        terminateRunner()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = LauncherController()
app.delegate = delegate
app.run()
