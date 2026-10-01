package com.prdoring.museamo

import org.junit.Assert.assertEquals
import org.junit.Test

class LocationLabelsTest {
    @Test fun sharedFixtures() {
        val fixtures = com.google.gson.JsonParser.parseString(java.io.File("../../test-fixtures/location-labels.json").readText()).asJsonArray
        fixtures.forEach { item ->
            val row = item.asJsonObject
            val location = row.getAsJsonObject("location")
            fun field(key: String) = location.get(key)?.asString ?: ""
            assertEquals(row.toString(), row.get("label").asString, LocationLabels.format(
                name = field("name"), address = field("address"), locality = field("locality"), userLabel = field("userLabel"),
                city = field("city"), region = field("region"), country = field("country"), countryCode = field("countryCode")
            ))
        }
    }
}
