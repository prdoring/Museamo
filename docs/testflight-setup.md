# Test Museamo on an iPhone from Windows

The route is **Windows → GitHub's Mac build machine → Apple TestFlight → your iPhone**. You can do the setup in a Windows browser and terminal; no personal Mac is required. The current app targets iPhone on iOS 16.4 or newer. Start with your own internal testing group.

Successful **Checks** runs for app or bundle changes pushed to `main` start **Mainline release**, which calls `iPhone TestFlight` with the reserved release commit and version and uploads automatically. Documentation-, test-, and known tooling-only changes skip release builds and uploads; see [CI scope](ci.md). Windows and Android publication proceeds independently. Pull requests never upload. You can still manually trigger `iPhone TestFlight` from `main` for validation; its upload checkbox defaults to off. A signed package, a successful upload, a processed TestFlight build, and installation on hardware are separate milestones.

## 1. Enroll your Apple Account

1. Sign in to [Apple Developer enrollment](https://developer.apple.com/programs/enroll/) with the account you want to own the app. Enable two-factor authentication if prompted.
2. Choose **Individual** if you personally own the app. Choose **Organization** if a legal entity owns it; Apple has additional requirements for that route.
3. Follow Apple's identity verification, agreement, and payment steps. Membership is generally US$99 per year or local pricing. Enrollment may remain pending until Apple verifies it.
4. After approval, open [your developer account](https://developer.apple.com/account). Find your **Team ID** in membership details. It is a 10-character identifier; it is different from the App Store Connect Issuer ID used later.
5. Sign in to [App Store Connect](https://appstoreconnect.apple.com/) with the same account. Accept any outstanding agreements required to create and upload an app.

You can install Apple's **TestFlight** app on your iPhone while waiting for enrollment. You won't see Museamo there until a build has been uploaded, processed, and assigned to you.

## 2. Register Museamo with Apple

In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list):

1. Open **Identifiers**, click **+**, choose **App IDs**, then **App**.
2. Enter **Museamo** as the description.
3. Select **Explicit** and enter exactly `com.prdoring.museamo` as the Bundle ID.
4. Leave optional capabilities off for this initial text-library app. Continue and register it.

If Apple says this identifier belongs to another team, stop here and adjust the project's identifier and workflow together before continuing. The signing script intentionally rejects other identifiers.

In [App Store Connect](https://appstoreconnect.apple.com/):

1. Open **Apps**, click **+**, then **New App**.
2. Choose **iOS**.
3. Name: **Museamo**. If the name is unavailable, choose an available name for the Apple listing; the device app can still display Museamo.
4. Primary language: **English (U.S.)**, or your intended listing language.
5. Bundle ID: select **com.prdoring.museamo**.
6. SKU: **museamo-ios**. This is your internal tracking label, not a password or a public app name.
7. User access: **Full Access** is sufficient for your own account. Click **Create**.

Creating the record does not publish the app. [Apple's app-record instructions](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)

## 3. Create the signing certificate from Windows

Open a terminal in this Museamo folder. The helper requires Node 22+ and OpenSSL; it automatically finds the OpenSSL bundled with Git for Windows. Set `MUSEAMO_OPENSSL` to an executable path if using a different installation. If using the helper on macOS, it selects Homebrew OpenSSL instead of Apple's older LibreSSL.

Run:

```powershell
npm run ios:signing -- request
```

The helper asks you to choose and repeat a password. Use 12–128 printable ASCII characters; spaces are supported. Password entry is hidden. Save it in your password manager.

It creates these files under the ignored `.tools/ios-signing` folder:

| File | Purpose |
| --- | --- |
| `distribution.certSigningRequest` | The certificate request to upload to Apple |
| `distribution.key.pem` | Your encrypted private signing key; keep it with your password |

In [Apple's certificate page](https://developer.apple.com/account/resources/certificates/list):

1. Click **+**.
2. Select **Apple Distribution**. Do not choose Apple Development or Developer ID.
3. Continue and upload `distribution.certSigningRequest`.
4. Download the resulting `.cer` file to your PC. Keep its original contents.

Back in the terminal, run:

```powershell
npm run ios:signing -- package
```

Enter the full path to the downloaded `.cer` file, then the signing key password. The helper checks that the certificate is unexpired, is an Apple Distribution identity, and matches your private key. It creates `.tools/ios-signing/distribution.p12`, using the same password. It refuses to overwrite existing keys or packages.

Keep an encrypted backup of the key, P12, and password in your password manager or another secure location. They are credentials; do not put them in Git, chat, screenshots, or issue attachments. Only the certificate request is uploaded in the certificate-creation step.

## 4. Create the distribution profile

In [Apple's profile page](https://developer.apple.com/account/resources/profiles/list):

1. Open **Profiles**, click **+**.
2. Under **Distribution**, choose **App Store Connect** for iOS. Do not choose Ad Hoc or Development.
3. Choose the explicit App ID **com.prdoring.museamo**.
4. Choose the **Apple Distribution** certificate you just created.
5. Name the profile **Museamo TestFlight**.
6. Generate and download its `.mobileprovision` file.

TestFlight does not require registering your iPhone's device ID. The build checks that this profile belongs to your team, uses Museamo's explicit ID, is unexpired, and contains the signing certificate. [Apple's distribution-profile instructions](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)

## 5. Give GitHub permission to upload builds

In **App Store Connect → Users and Access → Integrations → App Store Connect API**:

1. If you see **Request Access**, request it as the Account Holder and wait until API access is approved.
2. Open **Team Keys** and choose **Generate API Key** or **+**.
3. Name: **Museamo GitHub TestFlight**.
4. Access role: **Developer**. This is sufficient for uploading a build; the workflow does not create apps, certificates, or tester groups with this key.
5. Generate the key.
6. Record the **Key ID** and the **Issuer ID** shown in the Team Keys section.
7. Download `AuthKey_KEYID.p8`. Apple only lets you download the private key once. Keep a secure backup.

Use a **team** key for this workflow. An individual key has a different authentication setup. This API key authorizes the upload; the certificate and profile authorize signing. [Apple's API-key instructions](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)

Now run:

```powershell
npm run ios:signing -- configure
```

The helper uses the existing GitHub CLI login (`gh auth login` if you need to sign in) and asks for your Team ID, downloaded profile path, `.p8` path, Key ID, Issuer ID, and signing password. It sends the files directly to encrypted **repository Actions secrets** for `prdoring/Museamo`, through standard input, without printing their contents. It sets one ordinary repository variable for the Team ID. A partial failure can be retried; already saved entries are updated.

For manual setup, use **GitHub → prdoring/Museamo → Settings → Secrets and variables → Actions**:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `IOS_DISTRIBUTION_P12_BASE64` | Base64 contents of `distribution.p12` |
| Secret | `IOS_DISTRIBUTION_P12_PASSWORD` | The password you chose |
| Secret | `IOS_PROVISIONING_PROFILE_BASE64` | Base64 contents of the `.mobileprovision` file |
| Secret | `ASC_API_KEY_BASE64` | Base64 contents of `AuthKey_KEYID.p8` |
| Secret | `ASC_KEY_ID` | Apple's 10-character Key ID |
| Secret | `ASC_ISSUER_ID` | Apple's Issuer ID UUID |
| Variable | `IOS_TEAM_ID` | Your 10-character developer Team ID |

Base64 is a file encoding, not encryption. Store those values only as secrets. The configure helper performs the encoding for you. GitHub recommends keeping Apple signing material in [Actions secrets](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

## 6. Build, then upload

The workflow must first be reviewed and merged into `main` before it appears in GitHub's Actions list.

1. Open [Museamo's Actions page](https://github.com/prdoring/Museamo/actions).
2. Select **iPhone TestFlight**.
3. Click **Run workflow** and select **main**.
4. For the first run, leave **Upload the signed build to Apple TestFlight** unchecked.
5. Run it. GitHub checks configuration, tests the app, regenerates and verifies Museamo's iPhone icon and light/dark launch artwork, builds the web interface, signs the iPhone Release archive, checks branding in the compiled app, and exports the IPA. The asset source and local commands are described in [iOS development](ios-development.md#icon-and-launch-screen).
6. Open the run and confirm it succeeded. Its summary shows the version, build number, and source commit. The signed IPA and build record are retained as an artifact for seven days. The artifact excludes certificates, private keys, and provisioning-source files; temporary signing material is cleaned up even on failure.
7. Run the workflow again on **main**, this time checking the upload box. This builds a new numbered package, validates it with Apple, and uploads it to App Store Connect.
8. Wait for Apple processing. A successful GitHub upload is not yet a ready-to-install build. Apple emails the processing result; check **App Store Connect → Museamo → TestFlight → iOS**.

Automatic build versions follow the tagged release's package.json, starting with `0.4.1`; manual validation follows main's development version. All automatic jobs receive the resolved release commit explicitly, rather than using workflow_run's default SHA. Build numbers increase with the calling workflow's runs and retries, within Apple's component limits. Retry failed jobs in the original Mainline release run to preserve the reserved version. Avoid separate manual uploads of the same version using an unrelated workflow counter.

The upload calls Apple's `altool` through Xcode. [Apple's upload instructions](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)

## 7. Install the first build on your iPhone

1. Install Apple's **TestFlight** app from the iPhone App Store if you haven't already.
2. In **App Store Connect → Museamo → TestFlight**, add beta test information describing this initial text-library build.
3. Complete the build's encryption questionnaire using [the candidate privacy/encryption inventory](ios-privacy-inventory.md). The connected build bundles Rust's standard cryptography and declares `ITSAppUsesNonExemptEncryption=true`; the older text-only build's “None of the algorithms” answer must not be reused. Review Apple's [documentation table](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) for the algorithms and distribution territories, and complete any required owner documentation before testing/distribution.
4. Under **Internal Testing**, click **+** to create a group named **My devices** and select **Enable automatic distribution** so future processed mainline builds reach the group automatically.
5. Add yourself as an internal tester. As the Account Holder, your App Store Connect user is eligible; use the email associated with that user.
6. Confirm the processed build appears in the group (or add the first build manually) and send the invitation if prompted.
7. Open the invitation on your iPhone, accept it in TestFlight, and tap **Install**.
8. Open Museamo, save a sample thought, close the app, and reopen it. Confirm the thought remains. Then test an unfinished draft across relaunch.

Internal testing uses App Store Connect team members. External friends/testers use a separate external group and may require Beta App Review. Start with yourself before setting that up. A TestFlight build is available for testing for up to 90 days; upload newer builds as you develop. [Apple's internal tester instructions](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)

Current iOS support includes text, durable drafts, search, Gems, tags/checklists, and Recovery. Media, locations, portable backups, sync, shared hashtags, and widgets remain future work. Use sample data for the first hardware checks and follow [the iPhone checklist](ios-device-checklist.md).

## If something fails

| Symptom | Next action |
| --- | --- |
| Enrollment pending or App Store Connect unavailable | Finish Apple verification and required agreements first |
| Workflow missing | Ensure `testflight.yml` has been merged into `main` |
| Job skipped | Select `main` when running the workflow |
| Missing signing configuration | Run `ios:signing -- configure`, or check exact secret and variable names |
| OpenSSL not found | Install Git for Windows or set `MUSEAMO_OPENSSL` |
| Certificate does not match the key | Use the certificate issued for this CSR; preserve the existing private key |
| No valid Apple Distribution identity | Check P12 password, certificate expiry, and that the P12 contains the private key |
| Profile rejected | Regenerate an App Store Connect profile for this team, explicit app ID, and distribution certificate |
| Apple rejects authentication | Verify Team Key, Key ID, Issuer ID, Developer role, and that API access is approved |
| Duplicate build number | Start a new workflow run, or coordinate versions/counters if another uploader is being used |
| Upload accepted but no build yet | Wait for Apple's processing email; inspect TestFlight processing errors |
| Missing Compliance | Complete Apple's build encryption questionnaire |
| No invitation/build in TestFlight | Confirm the processed build and your user are both in the internal group |

Signing and hardware verification are pending until your membership, credentials, and first device installation are complete. Windows tests and the unsigned CI archive cannot verify those steps.
