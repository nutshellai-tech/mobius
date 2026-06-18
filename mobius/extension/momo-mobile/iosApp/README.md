# iOS shell

This folder contains the Swift entry used by the Compose Multiplatform iOS app.

On macOS, generate and embed the shared framework from the project root:

```bash
./gradlew :shared:embedAndSignAppleFrameworkForXcode
```

Then create/open an Xcode iOS app target with bundle id `com.mobius.momo`, add
`iosApp/iosApp/MomoMobileApp.swift`, and link the generated `MomoShared`
framework. This Linux development environment cannot run `xcodebuild`, so the
checked-in iOS shell is source-level only here.
