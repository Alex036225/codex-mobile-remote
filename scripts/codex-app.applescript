on run argv
  set commandName to item 1 of argv
  if commandName is "status" then return my codexStatus()
  if commandName is "activate" then return my activateCodex()
  if commandName is "send" then return my sendToCodex(item 2 of argv)
  if commandName is "snapshot" then return my codexSnapshot()
  error "Unknown command: " & commandName
end run

on codexStatus()
  tell application "System Events"
    set isRunning to exists process "Codex"
    if isRunning is false then return "running=false"
    tell process "Codex"
      return "running=true" & linefeed & "frontmost=" & (frontmost as text) & linefeed & "windows=" & ((count of windows) as text)
    end tell
  end tell
end codexStatus

on activateCodex()
  tell application "Codex" to activate
  delay 0.2
  tell application "System Events"
    tell process "Codex"
      set frontmost to true
    end tell
  end tell
  return "ok=true"
end activateCodex

on sendToCodex(messageText)
  tell application "Codex" to activate
  delay 0.25

  tell application "System Events"
    tell process "Codex"
      set frontmost to true
      delay 0.15
      try
        my focusLikelyInput(window 1)
      end try
      try
        set windowPosition to position of window 1
        set windowSize to size of window 1
        set clickX to (item 1 of windowPosition) + ((item 1 of windowSize) / 2)
        set clickY to (item 2 of windowPosition) + (item 2 of windowSize) - 90
        click at {clickX, clickY}
      end try
      delay 0.05
      set the clipboard to messageText
      keystroke "v" using {command down}
      delay 0.08
      key code 36
    end tell
  end tell

  return "ok=true"
end sendToCodex

on codexSnapshot()
  tell application "Codex" to activate
  delay 0.15

  set outputText to ""
  tell application "System Events"
    tell process "Codex"
      set frontmost to true
      repeat with w in windows
        set outputText to outputText & my dumpElement(w, 0)
      end repeat
    end tell
  end tell
  return outputText
end codexSnapshot

using terms from application "System Events"

on focusLikelyInput(theElement)
  set foundInput to false
  try
    repeat with childElement in (every UI element of theElement)
      if my focusLikelyInput(childElement) then set foundInput to true
    end repeat
  end try

  try
    set elementRole to role of theElement
    if elementRole is "AXTextArea" or elementRole is "AXTextField" then
      set focused of theElement to true
      return true
    end if
  end try

  return foundInput
end focusLikelyInput

on dumpElement(theElement, depth)
  if depth > 8 then return ""

  set lineText to ""
  try
    set elementRole to role of theElement
    set lineText to lineText & elementRole
  end try
  set lineText to lineText & tab

  try
    set elementName to name of theElement
    set lineText to lineText & elementName
  end try
  set lineText to lineText & tab

  try
    set elementValue to value of theElement
    set lineText to lineText & (elementValue as text)
  end try
  set lineText to lineText & tab

  try
    set elementDescription to description of theElement
    set lineText to lineText & elementDescription
  end try

  set outputText to ""
  if lineText is not (tab & tab & tab) then set outputText to lineText & linefeed

  try
    repeat with childElement in (every UI element of theElement)
      set outputText to outputText & my dumpElement(childElement, depth + 1)
    end repeat
  end try

  return outputText
end dumpElement

end using terms from
