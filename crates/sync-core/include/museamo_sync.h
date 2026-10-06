#ifndef MUSEAMO_SYNC_H
#define MUSEAMO_SYNC_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* ABI 1. All input buffers are borrowed for the duration of the call.
   JSON responses use {"ok":true,"result":...} / {"ok":false,"error":...}.
   Free Rust responses with museamo_sync_free; callback responses with release_response.
   retain_context/release_context balance once per runtime, including failed starts.
   Context remains retained until the last worker has dropped its platform reference.
   Runtime commands and destroy must be serialized by the host; evaluate is independent.
   Only trusted native code may call this interface. Never register it with the WebView. */
typedef struct {
    uint8_t *data;
    size_t len;
} MuseamoBuffer;
typedef MuseamoBuffer (*MuseamoCall)(void *, const uint8_t *, size_t, const uint8_t *, size_t);
typedef void (*MuseamoReleaseResponse)(void *, MuseamoBuffer);
typedef void (*MuseamoContextOperation)(void *);
typedef struct {
    uint32_t abi_version;
    void *context;
    MuseamoCall call;
    MuseamoReleaseResponse release_response;
    MuseamoContextOperation retain_context;
    MuseamoContextOperation release_context;
} MuseamoCallbacks;
typedef struct MuseamoRuntime MuseamoRuntime;
uint32_t museamo_sync_abi_version(void);
MuseamoRuntime *museamo_sync_create(MuseamoCallbacks callbacks, MuseamoBuffer *response);
MuseamoBuffer museamo_sync_command(MuseamoRuntime *, const uint8_t *, size_t, const uint8_t *, size_t);
MuseamoBuffer museamo_sync_evaluate(const uint8_t *, size_t);
void museamo_sync_destroy(MuseamoRuntime *);
void museamo_sync_free(MuseamoBuffer);
#ifdef __cplusplus
}
#endif
#endif
