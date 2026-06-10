import Foundation
import UserNotifications

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
	func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
		completionHandler([.banner, .sound])
	}
}

let args = CommandLine.arguments
let title = args.count > 1 ? args[1] : "pi"
let subtitle = args.count > 2 ? args[2] : "Turno completado"
let body = args.count > 3 ? args[3] : "Listo"
let sound = args.count > 4 ? args[4] : "Purr"

let center = UNUserNotificationCenter.current()
let delegate = Delegate()
center.delegate = delegate

let semaphore = DispatchSemaphore(value: 0)
center.requestAuthorization(options: [.alert, .sound]) { _, _ in
	let content = UNMutableNotificationContent()
	content.title = title
	content.subtitle = subtitle
	content.body = body
	content.sound = UNNotificationSound(named: UNNotificationSoundName(sound))
	let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
	center.add(request) { _ in semaphore.signal() }
}
_ = semaphore.wait(timeout: .now() + 5)
RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.5))
