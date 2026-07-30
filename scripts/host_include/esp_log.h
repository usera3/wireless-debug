#ifndef HOST_ESP_LOG_H
#define HOST_ESP_LOG_H

void host_test_log_info(void);
void host_test_log_warning(void);

#define ESP_LOGI(tag, ...) ((void)(tag), host_test_log_info())
#define ESP_LOGW(tag, ...) ((void)(tag), host_test_log_warning())

#endif
