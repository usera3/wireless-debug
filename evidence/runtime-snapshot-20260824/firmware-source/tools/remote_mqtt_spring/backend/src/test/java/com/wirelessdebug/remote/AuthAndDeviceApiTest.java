package com.wirelessdebug.remote;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.notNullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AuthAndDeviceApiTest {
  @Autowired
  private MockMvc mvc;

  @Test
  void unauthenticatedDevicesRequestIsRejected() throws Exception {
    mvc.perform(get("/api/devices"))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void loginReturnsHttpOnlyCookieAndAuthenticatedUserCanReadDevices() throws Exception {
    MvcResult login = mvc.perform(post("/api/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content("""
                {"email":"admin@example.com","password":"ChangeMe123!"}
                """))
        .andExpect(status().isOk())
        .andExpect(cookie().httpOnly("WD_ACCESS_TOKEN", true))
        .andExpect(jsonPath("$.user.email").value("admin@example.com"))
        .andExpect(jsonPath("$.accessToken", notNullValue()))
        .andReturn();

    String token = login.getResponse().getCookie("WD_ACCESS_TOKEN").getValue();

    mvc.perform(get("/api/me").cookie(new jakarta.servlet.http.Cookie("WD_ACCESS_TOKEN", token)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.email").value("admin@example.com"))
        .andExpect(jsonPath("$.role").value("ADMIN"));

    mvc.perform(get("/api/devices").cookie(new jakarta.servlet.http.Cookie("WD_ACCESS_TOKEN", token)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.devices").isArray());
  }

  @Test
  void commandRequestsPersistOperatorAndDeviceIntent() throws Exception {
    MvcResult login = mvc.perform(post("/api/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content("""
                {"email":"admin@example.com","password":"ChangeMe123!"}
                """))
        .andExpect(status().isOk())
        .andReturn();

    String token = login.getResponse().getCookie("WD_ACCESS_TOKEN").getValue();

    mvc.perform(post("/api/devices/esp32-001/commands")
            .cookie(new jakarta.servlet.http.Cookie("WD_ACCESS_TOKEN", token))
            .contentType(MediaType.APPLICATION_JSON)
            .content("""
                {"type":"query_status","args":{}}
                """))
        .andExpect(status().isAccepted())
        .andExpect(jsonPath("$.commandId", containsString("cmd-")))
        .andExpect(jsonPath("$.deviceId").value("esp32-001"))
        .andExpect(jsonPath("$.requestedBy").value("admin@example.com"));
  }
}
