package middleware

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const defaultJSONTextLimit = 2000

var stringFieldLimits = map[string]int{
	"name":                120,
	"displayname":         100,
	"description":         500,
	"remark":              500,
	"username":            100,
	"email":               200,
	"password":            128,
	"oldpassword":         128,
	"newpassword":         128,
	"confirmpassword":     128,
	"refreshtoken":        512,
	"role":                50,
	"rolename":            50,
	"roleid":              50,
	"project":             100,
	"projectid":           100,
	"environment":         100,
	"product":             100,
	"os":                  100,
	"runtype":             100,
	"branch":              200,
	"label":               120,
	"agentlabel":          100,
	"nodeid":              200,
	"nodename":            200,
	"stage":               200,
	"jobname":             200,
	"cmdlabel":            120,
	"matchproject":        100,
	"matchos":             100,
	"cronexpr":            100,
	"key":                 200,
	"value":               5000,
	"defaultvalue":        1000,
	"titletemplate":       300,
	"bodytemplate":        4000,
	"customemails":        2000,
	"webhookurl":          1000,
	"url":                 1000,
	"source":              1000,
	"dockerrepourl":       1000,
	"destpath":            500,
	"sourceinfolder":      500,
	"dockerstartscript":   500,
	"dockerimgreadfile":   500,
	"dockerimglabel":      500,
	"dockerimage":         500,
	"dockermount":         1000,
	"cmdrundir":           500,
	"runbash":             200,
	"operatorname":        100,
	"leadername":          100,
	"artifactoutput":      500,
	"artifactinput":       500,
	"keepartifacts":       5000,
	"cpulockscript":       200,
	"apprunid":            100,
	"token":               1000,
	"apitoken":            1000,
	"viewertoken":         1000,
	"refid":               100,
	"id":                  100,
	"avatarurl":           2_000_000,
}

var longTextFieldLimits = map[string]int{
	"content":            200_000,
	"deployscript":       50_000,
	"prescript":          50_000,
	"postscript":         50_000,
	"cmd":                50_000,
	"checkcmd":           5000,
	"configjson":         200_000,
	"stageconfigjson":    200_000,
	"dagconfigjson":      200_000,
	"runtimeparams":      20_000,
	"subpipelineparams":  20_000,
	"accesscontroljson":  20_000,
	"jenkinsbindings":    20_000,
	"channelconfigsjson": 20_000,
	"params":             20_000,
}

var stringFieldLabels = map[string]string{
	"name":          "Name",
	"displayname":   "Display name",
	"description":   "Description",
	"remark":        "Remark",
	"username":      "Username",
	"email":         "Email",
	"project":       "Project",
	"environment":   "Environment",
	"product":       "Product",
	"os":            "OS",
	"runtype":       "Run type",
	"branch":        "Branch",
	"agentlabel":    "Agent label",
	"jobname":       "Jenkins job name",
	"cronexpr":      "Cron expression",
	"key":           "Key",
	"value":         "Value",
	"defaultvalue":  "Default value",
	"titletemplate": "Title template",
	"bodytemplate":  "Body template",
	"customemails":  "Custom emails",
	"webhookurl":    "Webhook URL",
	"url":           "URL",
	"content":       "Content",
	"deployscript":  "Deploy script",
	"cmd":           "Command",
}

type stringLimitError struct {
	Field  string
	Limit  int
	Actual int
}

func (e stringLimitError) Error() string {
	label := stringFieldLabels[e.Field]
	if label == "" {
		label = e.Field
	}
	return fmt.Sprintf("Field %q allows up to %d characters, current length is %d", label, e.Limit, e.Actual)
}

func normalizedField(path []string) string {
	for i := len(path) - 1; i >= 0; i-- {
		part := strings.ToLower(strings.TrimSpace(path[i]))
		part = strings.ReplaceAll(part, "_", "")
		part = strings.ReplaceAll(part, "-", "")
		if part != "" {
			return part
		}
	}
	return ""
}

func limitForField(field string) int {
	if limit, ok := longTextFieldLimits[field]; ok {
		return limit
	}
	if limit, ok := stringFieldLimits[field]; ok {
		return limit
	}
	return defaultJSONTextLimit
}

func validateJSONStrings(value any, path []string) *stringLimitError {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if err := validateJSONStrings(child, append(path, key)); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range v {
			if err := validateJSONStrings(child, path); err != nil {
				return err
			}
		}
	case string:
		field := normalizedField(path)
		limit := limitForField(field)
		actual := utf8.RuneCountInString(v)
		if actual > limit {
			return &stringLimitError{Field: field, Limit: limit, Actual: actual}
		}
	}
	return nil
}

func shouldCheckStringLimits(c *gin.Context) bool {
	method := c.Request.Method
	if method != http.MethodPost && method != http.MethodPut && method != http.MethodPatch {
		return false
	}
	return strings.Contains(strings.ToLower(c.GetHeader("Content-Type")), "application/json")
}

// StringLengthLimit validates JSON string lengths before handlers write to DB.
func StringLengthLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !shouldCheckStringLimits(c) || c.Request.Body == nil {
			c.Next()
			return
		}

		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_BODY", "message": "Failed to read request body"})
			c.Abort()
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		if len(bytes.TrimSpace(body)) == 0 {
			c.Next()
			return
		}

		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.UseNumber()
		var payload any
		if err := decoder.Decode(&payload); err != nil {
			c.Next()
			return
		}
		if limitErr := validateJSONStrings(payload, nil); limitErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "FIELD_TOO_LONG",
				"message": limitErr.Error(),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
