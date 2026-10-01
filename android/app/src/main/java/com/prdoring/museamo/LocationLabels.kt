package com.prdoring.museamo

import java.util.Locale

object LocationLabels {
    private val states = mapOf(
        "Alabama" to "AL", "Alaska" to "AK", "Arizona" to "AZ", "Arkansas" to "AR", "California" to "CA",
        "Colorado" to "CO", "Connecticut" to "CT", "Delaware" to "DE", "Florida" to "FL", "Georgia" to "GA",
        "Hawaii" to "HI", "Idaho" to "ID", "Illinois" to "IL", "Indiana" to "IN", "Iowa" to "IA", "Kansas" to "KS",
        "Kentucky" to "KY", "Louisiana" to "LA", "Maine" to "ME", "Maryland" to "MD", "Massachusetts" to "MA",
        "Michigan" to "MI", "Minnesota" to "MN", "Mississippi" to "MS", "Missouri" to "MO", "Montana" to "MT",
        "Nebraska" to "NE", "Nevada" to "NV", "New Hampshire" to "NH", "New Jersey" to "NJ",
        "New Mexico" to "NM", "New York" to "NY", "North Carolina" to "NC", "North Dakota" to "ND",
        "Ohio" to "OH", "Oklahoma" to "OK", "Oregon" to "OR", "Pennsylvania" to "PA", "Rhode Island" to "RI",
        "South Carolina" to "SC", "South Dakota" to "SD", "Tennessee" to "TN", "Texas" to "TX", "Utah" to "UT",
        "Vermont" to "VT", "Virginia" to "VA", "Washington" to "WA", "West Virginia" to "WV",
        "Wisconsin" to "WI", "Wyoming" to "WY", "District of Columbia" to "DC"
    )
    private fun clean(value: String) = value.replace(Regex("\\s+"), " ").trim()
    private fun normalized(value: String) = clean(value.lowercase(Locale.ROOT).replace(Regex("[.,]"), ""))
    private fun stateCode(value: String) = states.entries.firstOrNull { normalized(value) == normalized(it.key) || value.uppercase(Locale.ROOT) == it.value }?.value

    fun format(name: String = "", address: String = "", locality: String = "", userLabel: String = "", city: String = "", region: String = "", country: String = "", countryCode: String = ""): String {
        val local = clean(locality)
        val parts = local.split(',').map { it.trim() }
        val town = clean(city).ifBlank { parts.first() }
        val state = clean(region).ifBlank { if (parts.size > 1) parts.last() else "" }
        val code = clean(countryCode).uppercase(Locale.ROOT)
        val nation = if (Regex("[A-Z]{2}").matches(code)) {
            Locale.Builder().setRegion(code).build().getDisplayCountry(Locale.ENGLISH).takeIf { it != code } ?: clean(country)
        } else clean(country)
        val us = code == "US" || (code.isBlank() && normalized(nation) in listOf("us", "usa", "united states", "united states of america")) || (code.isBlank() && nation.isBlank() && stateCode(state) != null)
        val area = when {
            us -> listOf(town, stateCode(state) ?: state).filter { it.isNotBlank() }.joinToString(" ").ifBlank { nation }
            nation.isNotBlank() -> listOf(town, nation).filter { it.isNotBlank() }.distinct().joinToString(", ")
            else -> local.ifBlank { listOf(town, state).filter { it.isNotBlank() }.joinToString(", ") }
        }
        val place = clean(userLabel).ifBlank { clean(name).takeIf { normalized(it) != normalized(clean(address)) } ?: "" }
        if (place.isBlank()) return area.ifBlank { "Saved location" }
        if (area.isBlank() || normalized(place) == normalized(area)) return place
        if (listOf(town, state, nation).any { it.isNotBlank() && normalized(it) == normalized(place) }) return area
        if (normalized(place).endsWith(" " + normalized(area))) return place
        return "$place, $area"
    }
}
