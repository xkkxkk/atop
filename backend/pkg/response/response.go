package response

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Response struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type PageData struct {
	Items    any   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
}

func OK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, Response{Code: "OK", Message: "success", Data: data})
}

func Created(c *gin.Context, data any) {
	c.JSON(http.StatusCreated, Response{Code: "OK", Message: "created", Data: data})
}

func Page(c *gin.Context, items any, total int64, page, pageSize int) {
	c.JSON(http.StatusOK, Response{
		Code: "OK", Message: "success",
		Data: PageData{Items: items, Total: total, Page: page, PageSize: pageSize},
	})
}

func BadRequest(c *gin.Context, code, msg string) {
	c.JSON(http.StatusBadRequest, Response{Code: code, Message: msg})
}

func Unauthorized(c *gin.Context, msg string) {
	c.JSON(http.StatusUnauthorized, Response{Code: "UNAUTHORIZED", Message: msg})
}

func Forbidden(c *gin.Context, msg string) {
	c.JSON(http.StatusForbidden, Response{Code: "FORBIDDEN", Message: msg})
}

func NotFound(c *gin.Context, msg string) {
	c.JSON(http.StatusNotFound, Response{Code: "NOT_FOUND", Message: msg})
}

func Conflict(c *gin.Context, code, msg string) {
	c.JSON(http.StatusConflict, Response{Code: code, Message: msg})
}

func Unprocessable(c *gin.Context, code, msg string) {
	c.JSON(http.StatusUnprocessableEntity, Response{Code: code, Message: msg})
}

func TooManyRequests(c *gin.Context, msg string, cooldownSeconds int) {
	c.JSON(http.StatusTooManyRequests, gin.H{
		"code":             "RATE_LIMITED",
		"message":          msg,
		"cooldown_seconds": cooldownSeconds,
	})
}

func InternalError(c *gin.Context, msg string) {
	c.JSON(http.StatusInternalServerError, Response{Code: "INTERNAL_ERROR", Message: msg})
}
