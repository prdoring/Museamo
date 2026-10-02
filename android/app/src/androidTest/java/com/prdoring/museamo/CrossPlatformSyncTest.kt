package com.prdoring.museamo

import android.content.Context
import android.content.ContextWrapper
import androidx.annotation.Keep
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** Opt-in synthetic integration gate: no production Room database or phone data is used. */
@RunWith(AndroidJUnit4::class)
class CrossPlatformSyncTest {
    @Test fun actualAndroidRoomJniCoordinatorPairsAndSyncsWithWindowsStore() {
        val endpoint = InstrumentationRegistry.getArguments().getString("hostEndpoint") ?: ""
        assumeTrue("Requires the isolated Windows fixture endpoint", endpoint.isNotBlank())
        val context = ApplicationProvider.getApplicationContext<Context>()
        val codeFile = File(context.cacheDir, "cross-platform-code.txt")
        val approvalFile = File(context.cacheDir, "cross-platform-approved.txt")
        val windowsPassedFile = File(context.cacheDir, "cross-platform-windows-passed.txt")
        val listenerFile = File(context.cacheDir, "cross-platform-listener.json")
        val resultFile = File(context.cacheDir, "cross-platform-result.json")
        codeFile.delete(); approvalFile.delete(); windowsPassedFile.delete(); listenerFile.delete(); resultFile.delete()
        val directory = File(context.cacheDir, "cross-platform-room-${uid()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) { override fun getFilesDir(): File = directory }
        val db = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build()
        try {
            assertTrue(SyncCore.available())
            val repo = Repository(db); val platform = SyncPlatform(isolated, repo)
            SyncJournal.configure(SyncIdentity(isolated))
            val tag = repo.saveTag(null, "Cross-platform tasks", "checklist")
            val bytes = "Museamo Android synthetic unsupported original\n".toByteArray()
            val checksum = SyncIdentity.hex(MessageDigest.getInstance("SHA-256").digest(bytes))
            val media = MediaRow(uid(), "image", "image/heic", "android-cross-original.heic", bytes.size.toLong(), 1, 1, null, checksum)
            repo.rawDao.insertMedia(media); MediaFiles(isolated, repo).file(media.id).outputStream().use { it.write(bytes) }
            val live = repo.commitDraft(repo.draft("cross-live", null, null).copy(text = "Android cross-platform marker", tagIds = jsonIds(listOf(tag.id)), mediaIds = jsonIds(listOf(media.id))))
            val archived = repo.commitDraft(repo.draft("cross-recovery", null, null).copy(text = "Android recovered cross-platform marker", tagIds = jsonIds(listOf(tag.id))))
            repo.delete(archived.id)
            val listening = if (InstrumentationRegistry.getArguments().getString("emulatorLoopback") == "true") {
                // ADB forwards reach guest loopback, outside Android's Wi-Fi-bound socket routes. Fixture only.
                // Loopback binding also suppresses mDNS hints for guest addresses the Windows host cannot route.
                val callback = object {
                    @Keep fun platformCall(method: String, input: String): String = if (method == "syncBindSocket")
                        JSONObject().put("ok", true).put("result", JSONObject()).toString() else platform.platformCall(method, input)
                }
                val start = SyncCore::class.java.getDeclaredMethod("startCoordinator", Any::class.java, String::class.java).apply { isAccessible = true }
                val response = JSONObject(start.invoke(null, callback, "127.0.0.1:0") as String)
                assertTrue("Fixture coordinator must start: ${response.optString("error")}", response.getBoolean("ok"))
                response.getJSONObject("result")
            } else SyncCore.start(platform)
            listenerFile.writeText(JSONObject().put("address", listening.getString("address")).put("deviceId", listening.getString("deviceId")).toString())
            SyncCore.command("linkDevice", JSONObject().put("address", endpoint))
            fun state() = SyncCore.command("getSyncState")
            fun awaitState(seconds: Long, condition: (JSONObject) -> Boolean): JSONObject {
                val deadline = System.nanoTime() + seconds * 1_000_000_000L
                var value = state()
                while (!condition(value) && System.nanoTime() < deadline) { Thread.sleep(200); value = state() }
                assertTrue("Timed out with native state: $value", condition(value)); return value
            }
            val pairing = awaitState(30) { it.optJSONObject("pairing") != null }.getJSONObject("pairing")
            val code = pairing.getString("code"); val session = pairing.getString("sessionId")
            codeFile.writeText(code)
            val approvalDeadline = System.nanoTime() + 120_000_000_000L
            while ((!approvalFile.isFile || approvalFile.readText().trim() != code) && System.nanoTime() < approvalDeadline) Thread.sleep(200)
            assertTrue("Both fixture screens must show the same code before approval", approvalFile.isFile && approvalFile.readText().trim() == code)
            SyncCore.command("confirmPairing", JSONObject().put("sessionId", session).put("confirmed", true))
            awaitState(30) { it.optJSONObject("pairing")?.optJSONObject("summary") != null }
            SyncCore.command("acceptEnrollment", JSONObject().put("sessionId", session).put("accepted", true))
            awaitState(120) { it.optJSONObject("pairing") == null && it.optString("phase") == "idle" && !it.isNull("groupId") && repo.dao.entries().any { row -> row.text == "Windows cross-platform marker" } }
            assertEquals(live.text, repo.dao.entry(live.id)?.text)
            assertEquals(1, repo.dao.tags().count { it.name.equals("Cross-platform tasks", ignoreCase = true) && it.type == "checklist" })
            assertTrue(repo.dao.recovery().any { JSONObject(it.payload).optString("text") == "Android recovered cross-platform marker" })
            assertTrue(MediaFiles(isolated, repo).intact(media))
            val immediate = repo.commitDraft(repo.draft("cross-immediate", null, null).copy(text = "Android immediate-sync marker"))
            val startedAt = System.nanoTime()
            SyncCore.command("localDataChanged")
            val immediateDeadline = startedAt + 10_000_000_000L
            while (repo.dao.entries().none { it.text == "Windows immediate-sync marker" } && System.nanoTime() < immediateDeadline) Thread.sleep(50)
            assertTrue("Both native writers must propagate without syncNow within ten seconds: ${state()}", repo.dao.entries().any { it.text == "Windows immediate-sync marker" })
            val elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000L
            println("Android-to-Windows writer and Windows-to-Android observation completed in ${elapsedMillis}ms without syncNow")
            resultFile.writeText(JSONObject().put("deviceId", listening.getString("deviceId")).put("entryId", live.id).put("mediaId", media.id).put("checksum", checksum)
                .put("immediateEntryId", immediate.id).put("immediateRoundTripMillis", elapsedMillis).put("state", state()).toString())
            val windowsDeadline = System.nanoTime() + 120_000_000_000L
            while ((!windowsPassedFile.isFile || windowsPassedFile.readText().trim() != code) && System.nanoTime() < windowsDeadline) Thread.sleep(200)
            assertTrue("Windows must verify the Android original checksum and Recovery before teardown", windowsPassedFile.isFile && windowsPassedFile.readText().trim() == code)
        } finally {
            runCatching { SyncCore.stop() }; db.close()
            directory.walkBottomUp().forEach { it.delete() }
        }
    }
}
