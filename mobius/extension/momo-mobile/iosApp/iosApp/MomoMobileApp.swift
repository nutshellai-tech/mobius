import SwiftUI
import MomoShared

@main
struct MomoMobileApp: App {
    var body: some Scene {
        WindowGroup {
            ComposeRoot()
                .ignoresSafeArea(.keyboard)
        }
    }
}

struct ComposeRoot: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        MainViewControllerKt.MainViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}
