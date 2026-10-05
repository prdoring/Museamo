import XCTest

/// Exercises the real React editor, Capacitor plugin, and on-device SQLite store.
/// Every run uses its own tag; existing thoughts and drafts are left intact.
final class PersistenceSmokeTests: XCTestCase {
    private var app: XCUIApplication!
    private let timeout: TimeInterval = 30

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        waitForLibrary()
    }

    override func tearDownWithError() throws {
        if testRun?.hasSucceeded == false {
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.lifetime = .keepAlways
            add(screenshot)
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        app.terminate()
    }

    func testSavedThoughtAndUnfinishedDraftSurviveTermination() {
        let token = UUID().uuidString
        let tagName = "UI smoke \(token.prefix(8))"
        let thought = "Saved iPhone thought \(token)"
        let draft = "Unfinished iPhone draft \(token)"

        createTag(tagName)
        openTag(tagName)
        let editor = openComposer()
        editor.tap()
        editor.typeText(thought)
        waitForText(thought, in: editor)
        tap(button("Send"))
        waitForSavedThought(thought)
        attachScreenshot("ios-library")

        relaunch()
        waitForSavedThought(thought)
        openTag(tagName)
        let draftEditor = openComposer()
        draftEditor.tap()
        draftEditor.typeText(draft)
        waitForText(draft, in: draftEditor)

        // Closing capture retains its draft. Reopening performs a native read
        // after the queued autosaves, so termination tests durable storage.
        tap(button("Close"))
        let reopened = openComposer()
        waitForText(draft, in: reopened)

        relaunch()
        waitForSavedThought(thought)
        openTag(tagName)
        waitForText(draft, in: openComposer())
        XCTAssertFalse(button("Attach photos/videos").exists)
        XCTAssertFalse(button("Post location").exists)
        attachScreenshot("ios-draft")
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForLibrary() {
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: timeout), "The native WKWebView did not launch.")
        XCTAssertTrue(button("Tags").waitForExistence(timeout: timeout), "The iOS library did not load.")
        XCTAssertFalse(app.staticTexts["Preview · resets on refresh"].exists, "An installed iPhone app must use native storage.")
    }

    private func relaunch() {
        app.terminate()
        app.launch()
        waitForLibrary()
    }

    private func createTag(_ name: String) {
        tap(button("Tags"))
        tap(button("New tag"))
        let field = app.webViews.textFields.matching(NSPredicate(format: "label CONTAINS[c] %@", "Tag name")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: timeout))
        field.tap()
        field.typeText(name)
        tap(button("Save tag"))
        XCTAssertTrue(button("New tag").waitForExistence(timeout: timeout), "The tag did not save.")
    }

    private func openTag(_ name: String) {
        tap(button("Tags"))
        XCTAssertTrue(button("New tag").waitForExistence(timeout: timeout))
        let search = app.webViews.textFields["Search tags"]
        if !search.exists { tap(button("Search")) }
        XCTAssertTrue(search.waitForExistence(timeout: timeout))
        search.tap()
        search.typeText(name)
        let tag = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", name)).firstMatch
        tap(tag)
    }

    private func openComposer() -> XCUIElement {
        let capture = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Message #")).firstMatch
        tap(capture)
        // WKWebView exposes contenteditable with role=textbox as a text view;
        // descendants also covers accessibility mapping changes across iOS.
        let editor = app.webViews.descendants(matching: .any).matching(identifier: "Thought text").firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: timeout), "The React composer did not open.")
        return editor
    }

    private func waitForSavedThought(_ text: String) {
        let saved = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: timeout), "The thought was not found in the persisted library.")
    }

    private func waitForText(_ text: String, in editor: XCUIElement) {
        let hasText = NSPredicate { _, _ in
            (editor.value as? String)?.contains(text) == true ||
                editor.label.contains(text) ||
                editor.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hasText, object: editor)], timeout: timeout), .completed, "The editor did not retain the expected text.")
    }

    private func button(_ label: String) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch
    }

    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "A required control did not appear.")
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true AND enabled == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [hittable], timeout: timeout), .completed, "A required control was not available to tap.")
        element.tap()
    }
}
